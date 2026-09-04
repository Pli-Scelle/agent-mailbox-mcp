import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ResponseBodyError } from 'openid-client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NoRefreshTokenError, refreshStoredTokens } from '../src/oauth/refresh.js'
import { type TokenRecord, writeTokenRecord } from '../src/oauth/token-store.js'

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
		cause: { error: 'invalid_grant', error_description: 'refresh token already used' },
		response: new Response('{}', { status: 400 }),
	})
}

describe('refreshStoredTokens', () => {
	let dir: string
	let previousXdgConfigHome: string | undefined

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), 'aiscelle-mcp-refresh-test-'))
		previousXdgConfigHome = process.env.XDG_CONFIG_HOME
		process.env.XDG_CONFIG_HOME = dir
		refreshTokenGrant.mockReset()
	})

	afterEach(async () => {
		if (previousXdgConfigHome === undefined) delete process.env.XDG_CONFIG_HOME
		else process.env.XDG_CONFIG_HOME = previousXdgConfigHome
		await rm(dir, { recursive: true, force: true })
	})

	it('makes exactly one network call for two refreshes racing on the same store; the loser reads the winner’s pair', async () => {
		await writeTokenRecord(expiringRecord())

		let releaseTokenEndpoint: (() => void) | undefined
		const held = new Promise<void>((resolve) => {
			releaseTokenEndpoint = resolve
		})
		refreshTokenGrant.mockImplementationOnce(async () => {
			await held
			return { access_token: 'fresh-at', refresh_token: 'rt-2', expires_in: 3_600 }
		})

		const configuration = {} as never

		const first = refreshStoredTokens(configuration)
		// Give the first call time to acquire the lock and enter
		// `refreshTokenGrant` before the second one starts racing it.
		await new Promise((resolve) => setTimeout(resolve, 10))
		const second = refreshStoredTokens(configuration)

		releaseTokenEndpoint?.()
		const [firstResult, secondResult] = await Promise.all([first, second])

		expect(refreshTokenGrant).toHaveBeenCalledTimes(1)
		expect(firstResult.accessToken).toBe('fresh-at')
		expect(secondResult.accessToken).toBe('fresh-at')
	})

	it('recovers from invalid_grant by reading a fresher pair a sibling process already wrote, without a new call', async () => {
		const before = expiringRecord()
		await writeTokenRecord(before)

		refreshTokenGrant.mockImplementationOnce(async () => {
			// Simulate a sibling process that reclaimed a stale lock, refreshed
			// first, and wrote its own fresh pair before this call's rejection
			// is even observed here.
			await writeTokenRecord({
				accessToken: 'sibling-at',
				refreshToken: 'sibling-rt',
				scope: 'mailbox:read',
				expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
				obtainedAt: new Date(Date.now() + 1_000).toISOString(),
			})
			throw invalidGrantError()
		})

		const result = await refreshStoredTokens({} as never)

		expect(refreshTokenGrant).toHaveBeenCalledTimes(1)
		expect(result.accessToken).toBe('sibling-at')
	})

	it('still throws invalid_grant when no fresher pair exists to fall back on', async () => {
		await writeTokenRecord(expiringRecord())
		refreshTokenGrant.mockRejectedValueOnce(invalidGrantError())

		await expect(refreshStoredTokens({} as never)).rejects.toMatchObject({ error: 'invalid_grant' })
	})

	it('throws NoRefreshTokenError when the stored record has no refresh token', async () => {
		await writeTokenRecord(expiringRecord({ refreshToken: undefined }))

		await expect(refreshStoredTokens({} as never)).rejects.toBeInstanceOf(NoRefreshTokenError)
		expect(refreshTokenGrant).not.toHaveBeenCalled()
	})
})
