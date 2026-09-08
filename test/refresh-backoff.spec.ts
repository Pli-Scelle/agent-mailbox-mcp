import { beforeEach, describe, expect, it } from 'vitest'
import {
	isRefreshBackoffActive,
	recordRefreshFailure,
	recordRefreshSuccess,
	refreshBackoffRemainingMs,
	resetRefreshBackoffForTests,
} from '../src/oauth/refresh-backoff.js'

describe('refresh backoff, shared across ensureValidSession callers in this process', () => {
	beforeEach(() => {
		resetRefreshBackoffForTests()
	})

	it('is inactive before any failure is recorded', () => {
		expect(isRefreshBackoffActive()).toBe(false)
		expect(refreshBackoffRemainingMs()).toBe(0)
	})

	it('becomes active immediately after a failure, and inactive again once the delay elapses', () => {
		const failedAt = new Date('2026-01-01T00:00:00.000Z')
		recordRefreshFailure(failedAt)

		expect(isRefreshBackoffActive(failedAt)).toBe(true)

		const justBeforeItEnds = new Date(failedAt.getTime() + 4_999)
		expect(isRefreshBackoffActive(justBeforeItEnds)).toBe(true)

		const afterTheFirstDelay = new Date(failedAt.getTime() + 5_000)
		expect(isRefreshBackoffActive(afterTheFirstDelay)).toBe(false)
	})

	it('grows the delay exponentially with each additional consecutive failure, capped at a maximum', () => {
		const t0 = new Date('2026-01-01T00:00:00.000Z')

		recordRefreshFailure(t0)
		expect(refreshBackoffRemainingMs(t0)).toBe(5_000)

		recordRefreshFailure(t0)
		expect(refreshBackoffRemainingMs(t0)).toBe(10_000)

		recordRefreshFailure(t0)
		expect(refreshBackoffRemainingMs(t0)).toBe(20_000)

		// Enough additional failures to hit the cap.
		for (let i = 0; i < 10; i += 1) recordRefreshFailure(t0)
		expect(refreshBackoffRemainingMs(t0)).toBe(5 * 60_000)
	})

	it('resets to no backoff at all on the next success', () => {
		const t0 = new Date('2026-01-01T00:00:00.000Z')
		recordRefreshFailure(t0)
		recordRefreshFailure(t0)
		expect(isRefreshBackoffActive(t0)).toBe(true)

		recordRefreshSuccess()

		expect(isRefreshBackoffActive(t0)).toBe(false)
		expect(refreshBackoffRemainingMs(t0)).toBe(0)
	})
})
