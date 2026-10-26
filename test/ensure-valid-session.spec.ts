import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ResponseBodyError } from 'openid-client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AccessLostError, RefreshBackedOffError, ensureValidSession } from '../src/oauth/ensure-valid-session.js'
import { resetRefreshBackoffForTests } from '../src/oauth/refresh-backoff.js'
import { type TokenRecord, readTokenRecord, writeTokenRecord } from '../src/oauth/token-store.js'

const loadRegisteredConfiguration = vi.fn()
vi.mock('../src/oauth/discovery.js', () => ({
	loadRegisteredConfiguration: (...args: Array<unknown>) => loadRegisteredConfiguration(...(args as [])),
}))

const refreshTokenGrant = vi.fn()
vi.mock('openid-client', async () => {
	const actual = await vi.importActual<typeof import('openid-client')>('openid-client')
	return {
		...actual,
		refreshTokenGrant: (...args: Array<unknown>) => refreshTokenGrant(...(args as [])),
	}
})

function expiringRecord(overrides: Partial<TokenRecord> = {}): TokenRecord {
	return {
		accessToken: 'stale-at',
		refreshToken: 'rt-1',
		scope: 'mailbox:read',
		expiresAt: new Date(Date.now() - 1_000).toISOString(),
		obtainedAt: new Date(Date.now() - 3_600_000).toISOString(),
		...overrides,
	}
}

function invalidGrantError(): ResponseBodyError {
	return new ResponseBodyError('invalid_grant', {
		cause: { error: 'invalid_grant', error_description: 'refresh token revoked' },
		response: new Response('{}', { status: 400 }),
	})
}

function transportFailure(): TypeError {
	// A network blip or a 5xx from an edge proxy never reaches openid-client
	// as a well-formed OAuth error body (oauth-grant-error.ts's doc
	// comment): it surfaces as a plain transport failure instead.
	return new TypeError('fetch failed')
}

describe('ensureValidSession, definitive vs. transitory refresh failures (issue #984)', () => {
	let dir: string
	let previousXdgConfigHome: string | undefined

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), 'aiscelle-mcp-ensure-session-test-'))
		previousXdgConfigHome = process.env.XDG_CONFIG_HOME
		process.env.XDG_CONFIG_HOME = dir

		refreshTokenGrant.mockReset()
		loadRegisteredConfiguration.mockReset()
		loadRegisteredConfiguration.mockResolvedValue({
			configuration: {},
			record: {
				clientId: 'device-1',
				redirectUri: 'http://127.0.0.1:1/cb',
				registeredAt: new Date().toISOString(),
			},
		})
		resetRefreshBackoffForTests()
	})

	afterEach(async () => {
		if (previousXdgConfigHome === undefined) delete process.env.XDG_CONFIG_HOME
		else process.env.XDG_CONFIG_HOME = previousXdgConfigHome
		await rm(dir, { recursive: true, force: true })
	})

	it('never replays invalid_grant: it is recorded once, and every later call fails without a new network call', async () => {
		await writeTokenRecord(expiringRecord())
		refreshTokenGrant.mockRejectedValue(invalidGrantError())

		await expect(ensureValidSession()).rejects.toBeInstanceOf(AccessLostError)
		expect(refreshTokenGrant).toHaveBeenCalledTimes(1)

		await expect(ensureValidSession()).rejects.toBeInstanceOf(AccessLostError)
		expect(refreshTokenGrant).toHaveBeenCalledTimes(1)

		const stored = await readTokenRecord()
		expect(stored?.accessLost?.reason).toBe('invalid_grant')
	})

	it('names the exact repair command in the error every later tool call would surface', async () => {
		await writeTokenRecord(expiringRecord())
		refreshTokenGrant.mockRejectedValueOnce(invalidGrantError())

		await expect(ensureValidSession()).rejects.toThrow(/npx @pliscelle\/agent-mailbox-mcp login/)
	})

	it('keeps retrying a transitory failure with a growing, capped backoff, never marking access as lost', async () => {
		await writeTokenRecord(expiringRecord())
		refreshTokenGrant.mockRejectedValue(transportFailure())

		await expect(ensureValidSession()).rejects.toThrow('fetch failed')
		expect(refreshTokenGrant).toHaveBeenCalledTimes(1)

		// An immediate retry is backed off locally, never sent to the network.
		await expect(ensureValidSession()).rejects.toBeInstanceOf(RefreshBackedOffError)
		expect(refreshTokenGrant).toHaveBeenCalledTimes(1)

		const stored = await readTokenRecord()
		expect(stored?.accessLost).toBeUndefined()
	})
})
