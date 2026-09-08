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
 * A plain lock FILE, not an OS advisory lock (`flock`), for the same reason
 * `config/local-store.ts` already avoids anything platform-specific here:
 * exclusive file creation (`open(path, 'wx')`) behaves identically on every
 * platform this package targets and needs no native addon.
 *
 * The lock has an OWNER. Its content is a random token this call generated,
 * never the empty string a bare "does this file exist" check would settle
 * for: a lock file with no owner cannot tell a live holder mid-refresh
 * apart from an abandoned one, so a purely mtime-based reclaim (this
 * module's first version) would let a waiting sibling steal the lock out
 * from under a holder that is simply slow, and reissue the very refresh
 * call this lock exists to prevent racing. Two things follow from having an
 * owner: `release` only ever removes a lock file whose content is still its
 * own token, and a live holder RENEWS its lock's mtime on a short interval
 * for as long as its callback runs, so the staleness threshold below only
 * ever fires for a holder that stopped renewing, which only happens if it
 * died.
 */
import { randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rm, stat, utimes } from 'node:fs/promises'
import { dirname } from 'node:path'
import { tokenStorePath } from '../config/paths.js'

const OWNER_READ_WRITE_EXECUTE_ONLY = 0o700

function lockPath(): string {
	return `${tokenStorePath()}.lock`
}

/**
 * A lock is renewed this often while its callback runs, well inside the
 * staleness threshold below: a live holder's lock file mtime is never more
 * than one interval old, so only a holder that actually stopped renewing
 * (because it died) can ever be judged stale.
 */
const RENEWAL_INTERVAL_MS = 1_000

/**
 * A lock older than this, with no renewal having touched its mtime, is
 * assumed to belong to a process that died mid-refresh (killed subprocess,
 * crash): several renewal intervals' worth of margin, so a live holder
 * merely slow to renew under load is never mistaken for a dead one.
 */
const STALE_LOCK_MS = 15_000

const ACQUIRE_RETRY_DELAY_MS = 50

/**
 * Comfortably longer than the staleness threshold: a waiter must be able to
 * both observe a dead lock as stale AND reclaim it before giving up, or this
 * timeout would fire on every genuinely dead lock it was meant to recover
 * from.
 */
const ACQUIRE_TIMEOUT_MS = 20_000

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms))
}

export class RefreshLockTimeoutError extends Error {
	constructor() {
		super('Timed out waiting for another AIScelle connector process to release the token refresh lock.')
		this.name = 'RefreshLockTimeoutError'
	}
}

export interface RefreshLockOptions {
	staleLockMs?: number
	renewalIntervalMs?: number
	acquireTimeoutMs?: number
	acquireRetryDelayMs?: number
}

interface ResolvedRefreshLockOptions {
	staleLockMs: number
	renewalIntervalMs: number
	acquireTimeoutMs: number
	acquireRetryDelayMs: number
}

function resolveOptions(options: RefreshLockOptions): ResolvedRefreshLockOptions {
	return {
		staleLockMs: options.staleLockMs ?? STALE_LOCK_MS,
		renewalIntervalMs: options.renewalIntervalMs ?? RENEWAL_INTERVAL_MS,
		acquireTimeoutMs: options.acquireTimeoutMs ?? ACQUIRE_TIMEOUT_MS,
		acquireRetryDelayMs: options.acquireRetryDelayMs ?? ACQUIRE_RETRY_DELAY_MS,
	}
}

async function reclaimIfStale(staleLockMs: number): Promise<void> {
	try {
		const stats = await stat(lockPath())
		if (Date.now() - stats.mtimeMs > staleLockMs) {
			await rm(lockPath(), { force: true })
		}
	} catch {
		// The lock vanished between the failed exclusive-create below and this
		// `stat`: whoever held it already released it, the next loop iteration's
		// `open` retries and succeeds on its own.
	}
}

/**
 * Acquires the lock, waiting out any other holder (or reclaiming a stale
 * one) up to `acquireTimeoutMs`, and returns the random ownership token
 * this call wrote into the lock file: the only value `release` below will
 * ever accept as proof this call is still the one allowed to remove it.
 * Exported for direct testing of the ownership invariant; `withRefreshLock`
 * is the only caller outside this module's own tests.
 */
export async function acquireLock(options: RefreshLockOptions = {}): Promise<string> {
	const { staleLockMs, acquireTimeoutMs, acquireRetryDelayMs } = resolveOptions(options)
	await mkdir(dirname(lockPath()), { recursive: true, mode: OWNER_READ_WRITE_EXECUTE_ONLY })

	const token = `${process.pid}:${randomUUID()}`
	const deadline = Date.now() + acquireTimeoutMs
	for (;;) {
		try {
			const handle = await open(lockPath(), 'wx')
			try {
				await handle.writeFile(token)
			} finally {
				await handle.close()
			}
			return token
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
		}

		if (Date.now() >= deadline) throw new RefreshLockTimeoutError()
		await reclaimIfStale(staleLockMs)
		await sleep(acquireRetryDelayMs)
	}
}

/**
 * Removes the lock file only if it still carries the exact token `acquire`
 * returned to this caller: a mismatch means some other process's lock is
 * sitting there now (a stale reclaim raced this release, however unlikely
 * with the renewal loop running), and touching a lock this call does not
 * own is exactly the bug the ownership token exists to close. A missing or
 * unreadable file is treated as already released, never as an error to
 * surface from a `finally` block.
 */
export async function releaseLock(token: string): Promise<void> {
	try {
		const content = await readFile(lockPath(), 'utf8')
		if (content === token) await rm(lockPath(), { force: true })
	} catch {
		// Already gone, or unreadable: nothing more a release can safely do.
	}
}

/**
 * Touches the lock file's mtime so `reclaimIfStale` never judges a live
 * holder's lock stale, but only while that lock still carries this call's
 * own token: if it does not (the file is gone, or somehow carries a
 * different token), there is nothing legitimate left to renew, and this
 * silently stops trying rather than resurrecting a lock nobody should still
 * be holding.
 */
async function renewLock(token: string): Promise<void> {
	try {
		const content = await readFile(lockPath(), 'utf8')
		if (content !== token) return
		const now = new Date()
		await utimes(lockPath(), now, now)
	} catch {
		// The lock file is gone or unreadable: nothing to renew. `release`'s
		// own token check is the source of truth for whether this call still
		// legitimately holds the lock, not this timer.
	}
}

function startRenewal(token: string, renewalIntervalMs: number): { stop: () => void } {
	const timer = setInterval(() => void renewLock(token), renewalIntervalMs)
	timer.unref()
	return { stop: () => clearInterval(timer) }
}

/**
 * Runs `fn` with the refresh lock held, renewed for as long as `fn` runs,
 * released even if `fn` throws. `oauth/refresh.ts`'s only caller: it
 * re-reads `tokens.json` right after acquiring the lock, before deciding
 * whether a network call is still needed at all, since the token this
 * process saw as near-expiry may already have been refreshed by whichever
 * sibling held the lock first. `options` overrides the module's defaults;
 * its only real callers today are this module's own tests, which need a
 * staleness threshold and renewal interval short enough to observe within
 * a test's own timeout.
 */
export async function withRefreshLock<T>(fn: () => Promise<T>, options: RefreshLockOptions = {}): Promise<T> {
	const resolved = resolveOptions(options)
	const token = await acquireLock(resolved)
	const renewal = startRenewal(token, resolved.renewalIntervalMs)
	try {
		return await fn()
	} finally {
		renewal.stop()
		await releaseLock(token)
	}
}
