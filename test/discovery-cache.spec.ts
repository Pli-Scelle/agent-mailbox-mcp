import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { writeClientRecord } from '../src/oauth/client-record.js'
import { ensureValidSession } from '../src/oauth/ensure-valid-session.js'
import { writeTokenRecord } from '../src/oauth/token-store.js'

const discovery = vi.fn()

vi.mock('openid-client', async () => {
	const actual = await vi.importActual<typeof import('openid-client')>('openid-client')
	return {
		...actual,
		discovery: (...args: Array<unknown>) => discovery(...(args as [])),
	}
})

/**
 * Issue #1939: `ensureValidSession` runs before every mailbox request and every heartbeat, and
 * rebuilt the OpenID configuration through a network discovery each time. The configuration is
 * cached, per backend and client, until it expires.
 */
describe('OpenID configuration cache', () => {
	let dir: string
	let previousXdgConfigHome: string | undefined
	let clientCounter = 0
	let clientId: string

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), 'aiscelle-mcp-discovery-cache-'))
		previousXdgConfigHome = process.env.XDG_CONFIG_HOME
		process.env.XDG_CONFIG_HOME = dir
		discovery.mockReset()
		discovery.mockImplementation(() => Promise.resolve({ discovered: true }))
		// A client id of its own per test: whatever a previous test cached is never this one's.
		clientCounter += 1
		clientId = `client-${clientCounter}`
		await writeClientRecord({
			clientId,
			redirectUri: 'http://127.0.0.1:53682/callback',
			registeredAt: new Date().toISOString(),
		})
		await writeTokenRecord({
			accessToken: 'at',
			refreshToken: 'rt',
			scope: 'mailbox:read',
			// Far beyond the cache lifetime: no refresh ever runs in these tests.
			expiresAt: new Date(Date.now() + 24 * 3_600_000).toISOString(),
			obtainedAt: new Date().toISOString(),
		})
	})

	afterEach(async () => {
		vi.useRealTimers()
		if (previousXdgConfigHome === undefined) delete process.env.XDG_CONFIG_HOME
		else process.env.XDG_CONFIG_HOME = previousXdgConfigHome
		await rm(dir, { recursive: true, force: true })
	})

	it('two successive sessions make a single discovery call', async () => {
		await ensureValidSession()
		await ensureValidSession()

		expect(discovery).toHaveBeenCalledTimes(1)
	})

	it('discovers again once the cached configuration has expired', async () => {
		vi.useFakeTimers({ toFake: ['Date'] })
		await ensureValidSession()
		vi.setSystemTime(Date.now() + 60 * 60 * 1000 + 1)

		await ensureValidSession()

		expect(discovery).toHaveBeenCalledTimes(2)
	})

	it('discovers again for another registered client', async () => {
		await ensureValidSession()
		await writeClientRecord({
			clientId: `${clientId}-re-registered`,
			redirectUri: 'http://127.0.0.1:53682/callback',
			registeredAt: new Date().toISOString(),
		})

		await ensureValidSession()

		expect(discovery).toHaveBeenCalledTimes(2)
	})

	it('does not keep a failed discovery: the next call tries again', async () => {
		discovery.mockRejectedValueOnce(new Error('network down'))
		await expect(ensureValidSession()).rejects.toThrow('network down')

		await ensureValidSession()

		expect(discovery).toHaveBeenCalledTimes(2)
	})
})
