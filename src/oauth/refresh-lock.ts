/**
 * Inter-process lock serializing token refresh across every instance of
 * this connector running concurrently on the same machine (issue #966: an
 * agentic host spawns one `pliscelle-mcp serve` subprocess per session, and
 * every one of them shares the same `tokens.json`). Without this, two
 * sibling processes can both read the same near-expiry refresh token and
 * both call the token endpoint with it; the server's rotation doctrine
 * (spec section 6.11, `agent_mailbox_oidc_adapter.ts`'s `consume`) treats
 * the second call as a replay and revokes the whole token family, which
 * kills every sibling's session at once, not just the loser's.
 *
 * The lock itself (owner token, renewal, stale reclaim) is
 * `config/state-file-lock.ts`, shared with the other local state files;
 * this module binds it to `tokens.json` and keeps its own timeout error.
 */
import { tokenStorePath } from '../config/paths.js'
import {
	type StateFileLockOptions,
	acquireFileLock,
	lockPathFor,
	releaseFileLock,
	withFileLock,
} from '../config/state-file-lock.js'

export class RefreshLockTimeoutError extends Error {
	constructor() {
		super('Timed out waiting for another AIScellé connector process to release the token refresh lock.')
		this.name = 'RefreshLockTimeoutError'
	}
}

export type RefreshLockOptions = Omit<StateFileLockOptions, 'timeoutError'>

function lockPath(): string {
	return lockPathFor(tokenStorePath())
}

function withTimeoutError(options: RefreshLockOptions): StateFileLockOptions {
	return { ...options, timeoutError: () => new RefreshLockTimeoutError() }
}

/**
 * Acquires the refresh lock and returns the ownership token `releaseLock`
 * requires. Exported for direct testing of the ownership invariant;
 * `withRefreshLock` is the only caller outside this module's own tests.
 */
export async function acquireLock(options: RefreshLockOptions = {}): Promise<string> {
	return acquireFileLock(lockPath(), withTimeoutError(options))
}

/** Removes the refresh lock only if it still carries `token`. */
export async function releaseLock(token: string): Promise<void> {
	await releaseFileLock(lockPath(), token)
}

/**
 * Runs `fn` with the refresh lock held, renewed for as long as `fn` runs,
 * released even if `fn` throws. `oauth/refresh.ts`'s only caller: it
 * re-reads `tokens.json` right after acquiring the lock, before deciding
 * whether a network call is still needed at all, since the token this
 * process saw as near-expiry may already have been refreshed by whichever
 * sibling held the lock first. `options` overrides the shared defaults;
 * its only real callers today are this module's own tests, which need a
 * staleness threshold and renewal interval short enough to observe within
 * a test's own timeout.
 */
export async function withRefreshLock<T>(fn: () => Promise<T>, options: RefreshLockOptions = {}): Promise<T> {
	return withFileLock(lockPath(), fn, withTimeoutError(options))
}
