/**
 * Process-wide exponential backoff for token refresh attempts, shared by
 * every caller of `ensureValidSession` in this process (issue #966): the
 * mailbox API client (`api/mailbox-client.ts`, called by every MCP tool)
 * and the periodic presence heartbeat (`server/heartbeat.ts`) both reach a
 * near-expiry token through `ensureValidSession`, and the heartbeat's own
 * 60s timer keeps firing regardless of whether the last beat succeeded.
 * Backing off in this one shared module, rather than in either caller
 * separately, is what stops that timer from hammering a token endpoint
 * that just answered `invalid_grant`: the timer still fires, but each
 * beat's `ensureValidSession` call now fails fast against this module's
 * state instead of reaching the network again.
 *
 * Deliberately module-level (not per-lock, not persisted): a refresh
 * failure is a property of THIS process's relationship with the token
 * endpoint right now, not something worth serializing to disk for a
 * process that will restart into a clean state anyway.
 */
const INITIAL_DELAY_MS = 5_000
const MAX_DELAY_MS = 5 * 60_000

let consecutiveFailures = 0
let backoffUntilMs = 0

export function recordRefreshFailure(now: Date = new Date()): void {
	consecutiveFailures += 1
	const delay = Math.min(MAX_DELAY_MS, INITIAL_DELAY_MS * 2 ** (consecutiveFailures - 1))
	backoffUntilMs = now.getTime() + delay
}

export function recordRefreshSuccess(): void {
	consecutiveFailures = 0
	backoffUntilMs = 0
}

export function refreshBackoffRemainingMs(now: Date = new Date()): number {
	return Math.max(0, backoffUntilMs - now.getTime())
}

export function isRefreshBackoffActive(now: Date = new Date()): boolean {
	return refreshBackoffRemainingMs(now) > 0
}

/**
 * Test-only reset for this module's process-global state: without it, one
 * spec file's failures would leak into the next test's assertions since
 * this state is not scoped to any object a test could construct fresh.
 */
export function resetRefreshBackoffForTests(): void {
	consecutiveFailures = 0
	backoffUntilMs = 0
}
