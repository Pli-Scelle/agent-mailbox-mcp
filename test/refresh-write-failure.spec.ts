import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as localStore from '../src/config/local-store.js'
import { tokenStorePath } from '../src/config/paths.js'
import { refreshStoredTokens } from '../src/oauth/refresh.js'
import { type TokenRecord, readTokenRecord, writeTokenRecord } from '../src/oauth/token-store.js'

const refreshTokenGrant = vi.fn()

vi.mock('openid-client', async () => {
	const actual = await vi.importActual<typeof import('openid-client')>('openid-client')
	return {
		...actual,
		refreshTokenGrant: (...args: Array<unknown>) => refreshTokenGrant(...(args as [])),
	}
})

vi.mock('../src/config/local-store.js', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../src/config/local-store.js')>()
	return { ...actual, writeJsonState: vi.fn(actual.writeJsonState) }
})

const actualStore = await vi.importActual<typeof import('../src/config/local-store.js')>('../src/config/local-store.js')

function expiringRecord(): TokenRecord {
	return {
		accessToken: 'stale-at',
		refreshToken: 'rt-consumed',
		scope: 'mailbox:read',
		expiresAt: new Date(Date.now() - 1_000).toISOString(),
		obtainedAt: new Date(Date.now() - 3_600_000).toISOString(),
	}
}

function diskError(code: 'ENOSPC' | 'EPERM'): NodeJS.ErrnoException {
	const error: NodeJS.ErrnoException = new Error(`${code}: simulated write failure`)
	error.code = code
	return error
}

/**
 * Issue #1941: once the token endpoint answered, the server has consumed the stored refresh
 * token. A local write failing at that point must neither lose the rotated pair nor leave the
 * consumed token in `tokens.json`, where any sibling process would replay it into a revocation
 * of the whole token family.
 */
describe('refreshStoredTokens when the rotated pair cannot be written', () => {
	let dir: string
	let previousXdgConfigHome: string | undefined

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), 'aiscelle-mcp-refresh-write-'))
		previousXdgConfigHome = process.env.XDG_CONFIG_HOME
		process.env.XDG_CONFIG_HOME = dir
		refreshTokenGrant.mockReset()
	})

	afterEach(async () => {
		vi.mocked(localStore.writeJsonState).mockReset()
		vi.mocked(localStore.writeJsonState).mockImplementation(actualStore.writeJsonState)
		// Any pair a failed write left pending in this process is drained by a read that persists it.
		await readTokenRecord()
		if (previousXdgConfigHome === undefined) delete process.env.XDG_CONFIG_HOME
		else process.env.XDG_CONFIG_HOME = previousXdgConfigHome
		await rm(dir, { recursive: true, force: true })
	})

	for (const code of ['ENOSPC', 'EPERM'] as const) {
		it(`keeps the rotated pair and drops the consumed refresh token from disk on ${code}`, async () => {
			await writeTokenRecord(expiringRecord())
			refreshTokenGrant.mockResolvedValueOnce({
				access_token: 'fresh-at',
				refresh_token: 'rt-rotated',
				expires_in: 3_600,
			})
			vi.mocked(localStore.writeJsonState).mockRejectedValueOnce(diskError(code))

			const result = await refreshStoredTokens({} as never).catch((error: Error) => error)

			const onDisk = await readFile(tokenStorePath(), 'utf8').catch(() => '')
			expect(onDisk).not.toContain('rt-consumed')
			expect(result instanceof Error ? result.message : result.refreshToken).toBe('rt-rotated')
			expect((await readTokenRecord())?.refreshToken).toBe('rt-rotated')
		})
	}

	it('writes the rotated pair to disk as soon as the disk accepts it again', async () => {
		await writeTokenRecord(expiringRecord())
		refreshTokenGrant.mockResolvedValueOnce({
			access_token: 'fresh-at',
			refresh_token: 'rt-rotated',
			expires_in: 3_600,
		})
		vi.mocked(localStore.writeJsonState).mockRejectedValueOnce(diskError('ENOSPC'))
		await refreshStoredTokens({} as never).catch(() => undefined)

		await readTokenRecord()

		const onDisk = JSON.parse(await readFile(tokenStorePath(), 'utf8')) as TokenRecord
		expect(onDisk.refreshToken).toBe('rt-rotated')
		expect(refreshTokenGrant).toHaveBeenCalledTimes(1)
	})
})
