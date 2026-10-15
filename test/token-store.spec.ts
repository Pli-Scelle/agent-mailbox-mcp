import { describe, expect, it } from 'vitest'
import { type TokenRecord, isTokenRecordExpiring, toTokenRecord } from '../src/oauth/token-store.js'

describe('toTokenRecord', () => {
	it('computes an absolute expiresAt from a relative expires_in', () => {
		const before = Date.now()
		const record = toTokenRecord({ access_token: 'at', expires_in: 3600 }, 'mailbox:read')
		const after = Date.now()

		const expiresAtMs = new Date(record.expiresAt).getTime()
		expect(expiresAtMs).toBeGreaterThanOrEqual(before + 3600_000)
		expect(expiresAtMs).toBeLessThanOrEqual(after + 3600_000)
	})

	it('falls back to the caller-supplied scope when the response omits one', () => {
		const record = toTokenRecord({ access_token: 'at', expires_in: 60 }, 'mailbox:read mailbox:write')
		expect(record.scope).toBe('mailbox:read mailbox:write')
	})

	it('keeps the response scope when the response provides one', () => {
		const record = toTokenRecord(
			{ access_token: 'at', expires_in: 60, scope: 'mailbox:read' },
			'mailbox:read mailbox:write',
		)
		expect(record.scope).toBe('mailbox:read')
	})

	it('carries the refresh token through when present', () => {
		const record = toTokenRecord({ access_token: 'at', refresh_token: 'rt', expires_in: 60 }, 'mailbox:read')
		expect(record.refreshToken).toBe('rt')
	})

	it('leaves refreshToken undefined when the response has none', () => {
		const record = toTokenRecord({ access_token: 'at', expires_in: 60 }, 'mailbox:read')
		expect(record.refreshToken).toBeUndefined()
	})
})

describe('isTokenRecordExpiring', () => {
	function recordExpiringIn(ms: number): TokenRecord {
		return {
			accessToken: 'at',
			scope: 'mailbox:read',
			expiresAt: new Date(Date.now() + ms).toISOString(),
			obtainedAt: new Date().toISOString(),
		}
	}

	it('is false for a token comfortably far from expiry', () => {
		expect(isTokenRecordExpiring(recordExpiringIn(10 * 60_000))).toBe(false)
	})

	it('is true for a token already past its expiry', () => {
		expect(isTokenRecordExpiring(recordExpiringIn(-1_000))).toBe(true)
	})

	it('is true inside the safety margin, before actual expiry', () => {
		expect(isTokenRecordExpiring(recordExpiringIn(10_000))).toBe(true)
	})
})
