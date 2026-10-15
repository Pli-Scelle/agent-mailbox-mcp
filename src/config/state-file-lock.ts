/**
 * Inter-process lock around one of this connector's local state files. An
 * agentic host spawns one `pliscelle-mcp serve` subprocess per session, and
 * every one of them shares the same configuration directory; the tool calls
 * of a single process overlap too. A state file rewritten as a whole after a
 * read (`config/local-store.ts`) therefore needs its read and its write held
 * under one lock, or a concurrent writer's change is lost (issue #966 for the
 * token pair, issue #1938 for the elicitation state).
 *
 * A plain lock FILE, not an OS advisory lock (`flock`), for the same reason
 * `config/local-store.ts` already avoids anything platform-specific here:
 * exclusive file creation (`open(path, 'wx')`) behaves identically on every
 * platform this package targets and needs no native addon.
 *
 * The lock has an OWNER. Its content is a random token this call generated,
 * never the empty string a bare "does this file exist" check would settle
 * for: a lock file with no owner cannot tell a live holder apart from an
 * abandoned one, so a purely mtime-based reclaim would let a waiting sibling
 * steal the lock out from under a holder that is simply slow. Two things
 * follow from having an owner: `releaseFileLock` only ever removes a lock
 * file whose content is still its own token, and a live holder RENEWS its
 * lock's mtime on a short interval for as long as its callback runs, so the
 * staleness threshold below only fires for a holder that stopped renewing.
 * That is a holder that died, but also one that is alive and could not renew:
 * a process stopped (suspended machine, SIGSTOP) or whose event loop was
 * blocked for longer than the threshold. Such a holder loses its lock to the
 * next caller, like with any lease, and runs on unaware until its release.
 *
 * A lock is only ever removed by moving it aside under a unique name, an
 * atomic step, and reading the token of the file captured. When the file
 * captured is not the one the caller meant (a lock taken over between the
 * caller's read and the move), the path is free for the length of the put
 * back, and a third caller can create its own lock there. Both sides close
 * that window: the lock is put back by `rename`, which replaces whatever was
 * created in the meantime, and `acquireFileLock` waits for the captured files
 * to be settled (they are named `<lock>.<pid>.<uuid>.removing`) before it
 * takes its own creation for a lock it holds, then reads its token back: a
 * lock replaced by the put back is not a lock held. At most one holder remains.
 * What can still go wrong is a lock put back for a holder that had already
 * released it (it then waits for the staleness threshold), never two holders.
 */
import { randomUUID } from 'node:crypto'
import { mkdir, open, readFile, readdir, rename, rm, stat, utimes } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

const OWNER_READ_WRITE_EXECUTE_ONLY = 0o700

/**
 * A lock is renewed this often while its callback runs, well inside the
 * staleness threshold below: a live holder's lock file mtime is never more
 * than one interval old, so only a holder that actually stopped renewing
 * (because it died) can ever be judged stale.
 */
const RENEWAL_INTERVAL_MS = 1_000

/**
 * A lock older than this, with no renewal having touched its mtime, is
 * assumed to belong to a process that died while holding it (killed
 * subprocess, crash): several renewal intervals' worth of margin, so a live
 * holder merely slow to renew under load is never mistaken for a dead one.
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

export class StateFileLockTimeoutError extends Error {
	constructor(lockPath: string) {
		super(`Timed out waiting for another AIScellé connector process to release ${lockPath}.`)
		this.name = 'StateFileLockTimeoutError'
	}
}

export interface StateFileLockOptions {
	staleLockMs?: number
	renewalIntervalMs?: number
	acquireTimeoutMs?: number
	acquireRetryDelayMs?: number
	/** The error thrown when the lock cannot be acquired in time; `StateFileLockTimeoutError` by default. */
	timeoutError?: () => Error
}

interface ResolvedStateFileLockOptions {
	staleLockMs: number
	renewalIntervalMs: number
	acquireTimeoutMs: number
	acquireRetryDelayMs: number
	timeoutError?: () => Error
}

function resolveOptions(options: StateFileLockOptions): ResolvedStateFileLockOptions {
	return {
		staleLockMs: options.staleLockMs ?? STALE_LOCK_MS,
		renewalIntervalMs: options.renewalIntervalMs ?? RENEWAL_INTERVAL_MS,
		acquireTimeoutMs: options.acquireTimeoutMs ?? ACQUIRE_TIMEOUT_MS,
		acquireRetryDelayMs: options.acquireRetryDelayMs ?? ACQUIRE_RETRY_DELAY_MS,
		timeoutError: options.timeoutError,
	}
}

/** The lock file guarding a state file. */
export function lockPathFor(statePath: string): string {
	return `${statePath}.lock`
}

const CAPTURE_SUFFIX = '.removing'

/**
 * Removes the lock file only if it still carries `expectedToken`. Deciding on
 * one read and then removing the PATH would remove whatever lock sits there by
 * then, possibly one another caller took in between. The lock is first moved
 * aside under a unique name, an atomic step that captures one file whatever
 * happens to the path afterwards; the token is read from that captured file.
 * A token that is not the expected one means another caller's lock was
 * captured: it is moved back in place by `rename`. The path was free for that
 * instant, so a lock a third caller created there is replaced, and that
 * caller finds out (`acquireFileLock` reads its token back once no captured
 * file is left). The captured name disappears in the same atomic step.
 */
async function removeLockIfOwnedBy(lockPath: string, expectedToken: string): Promise<void> {
	const captured = `${lockPath}.${process.pid}.${randomUUID()}${CAPTURE_SUFFIX}`
	try {
		await rename(lockPath, captured)
	} catch {
		// No lock file at that path any more: nothing to remove.
		return
	}
	try {
		const content = await readFile(captured, 'utf8')
		if (content !== expectedToken) {
			await rename(captured, lockPath).catch(() => undefined)
		}
	} finally {
		await rm(captured, { force: true })
	}
}

/**
 * Whether a lock is being moved aside right now: a file captured by
 * `removeLockIfOwnedBy` and not yet dropped or put back. One last touched long
 * ago is the leftover of a process that died in between, not a capture in
 * progress: a lock that lives is renewed, a stale one is not worth waiting for.
 */
async function hasCaptureInProgress(lockPath: string, staleLockMs: number): Promise<boolean> {
	const prefix = `${basename(lockPath)}.`
	const names = await readdir(dirname(lockPath)).catch(() => [] as Array<string>)
	for (const name of names) {
		if (!name.startsWith(prefix) || !name.endsWith(CAPTURE_SUFFIX)) continue
		const stats = await stat(join(dirname(lockPath), name)).catch(() => null)
		if (stats && Date.now() - stats.mtimeMs <= staleLockMs) return true
	}
	return false
}

/**
 * Whether the lock file just created is still this call's own once no lock
 * is being moved aside. A lock created while the path was free for a put back
 * is replaced by it; the file is read back after the captures are settled.
 */
async function holdsLockOnceSettled(
	lockPath: string,
	token: string,
	staleLockMs: number,
	deadline: number,
	retryDelayMs: number,
): Promise<boolean> {
	while ((await hasCaptureInProgress(lockPath, staleLockMs)) && Date.now() < deadline) {
		await sleep(retryDelayMs)
	}
	return (await readFile(lockPath, 'utf8').catch(() => null)) === token
}

async function reclaimIfStale(lockPath: string, staleLockMs: number): Promise<void> {
	try {
		const content = await readFile(lockPath, 'utf8')
		const stats = await stat(lockPath)
		if (Date.now() - stats.mtimeMs > staleLockMs) {
			await removeLockIfOwnedBy(lockPath, content)
		}
	} catch {
		// The lock vanished between the failed exclusive-create below and this
		// read: whoever held it already released it, the next loop iteration's
		// `open` retries and succeeds on its own.
	}
}

/**
 * Acquires the lock, waiting out any other holder (or reclaiming a stale
 * one) up to `acquireTimeoutMs`, and returns the random ownership token
 * this call wrote into the lock file: the only value `releaseFileLock`
 * will ever accept as proof this call is still the one allowed to remove it.
 */
export async function acquireFileLock(lockPath: string, options: StateFileLockOptions = {}): Promise<string> {
	const { staleLockMs, acquireTimeoutMs, acquireRetryDelayMs, timeoutError } = resolveOptions(options)
	await mkdir(dirname(lockPath), { recursive: true, mode: OWNER_READ_WRITE_EXECUTE_ONLY })

	const token = `${process.pid}:${randomUUID()}`
	const deadline = Date.now() + acquireTimeoutMs
	for (;;) {
		try {
			const handle = await open(lockPath, 'wx')
			try {
				await handle.writeFile(token)
			} finally {
				await handle.close()
			}
			if (await holdsLockOnceSettled(lockPath, token, staleLockMs, deadline, acquireRetryDelayMs)) return token
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
		}

		if (Date.now() >= deadline) throw timeoutError ? timeoutError() : new StateFileLockTimeoutError(lockPath)
		await reclaimIfStale(lockPath, staleLockMs)
		await sleep(acquireRetryDelayMs)
	}
}

/**
 * Removes the lock file only if it still carries the exact token
 * `acquireFileLock` returned to this caller: a mismatch means some other
 * process's lock is sitting there now, and touching a lock this call does
 * not own is exactly the bug the ownership token exists to close. A missing
 * or unreadable file is treated as already released, never as an error to
 * surface from a `finally` block.
 *
 * The token is read in place first, and a lock that is not this caller's is
 * left exactly where it is: `removeLockIfOwnedBy` moves the file aside before
 * it reads it, and moving a live holder's lock, even to put it back, frees
 * the path for a third caller for that instant. Only a lock read as this
 * caller's own goes through the capture, which then guards the one case left,
 * a lock taken over between this read and the removal.
 */
export async function releaseFileLock(lockPath: string, token: string): Promise<void> {
	try {
		if ((await readFile(lockPath, 'utf8')) !== token) return
		await removeLockIfOwnedBy(lockPath, token)
	} catch {
		// Missing or unreadable: nothing more a release can safely do.
	}
}

/**
 * Touches the lock file's mtime so `reclaimIfStale` never judges a live
 * holder's lock stale, but only while that lock still carries this call's
 * own token: if it does not, there is nothing legitimate left to renew, and
 * this silently stops trying rather than resurrecting a lock nobody should
 * still be holding.
 */
async function renewLock(lockPath: string, token: string): Promise<void> {
	try {
		const content = await readFile(lockPath, 'utf8')
		if (content !== token) return
		const now = new Date()
		await utimes(lockPath, now, now)
	} catch {
		// The lock file is gone or unreadable: nothing to renew. The release's
		// own token check is the source of truth for whether this call still
		// legitimately holds the lock, not this timer.
	}
}

function startRenewal(lockPath: string, token: string, renewalIntervalMs: number): { stop: () => void } {
	const timer = setInterval(() => void renewLock(lockPath, token), renewalIntervalMs)
	timer.unref()
	return { stop: () => clearInterval(timer) }
}

/** Runs `fn` with the lock held, renewed for as long as `fn` runs, released even if `fn` throws. */
export async function withFileLock<T>(
	lockPath: string,
	fn: () => Promise<T>,
	options: StateFileLockOptions = {},
): Promise<T> {
	const resolved = resolveOptions(options)
	const token = await acquireFileLock(lockPath, resolved)
	const renewal = startRenewal(lockPath, token, resolved.renewalIntervalMs)
	try {
		return await fn()
	} finally {
		renewal.stop()
		await releaseFileLock(lockPath, token)
	}
}
