/**
 * In-process, never-persisted bridge between `tools/read.ts` and
 * `resources/sensitive-message-resource.ts` for the SAME logical read of a
 * sensitive message. This connector never writes a message cache or
 * decrypted content to disk: this module respects that by never touching
 * disk at all, it only holds a `Map` in this process's memory, which is
 * gone the instant the process exits.
 *
 * Why this exists: `GET /agent-mailbox/messages/:id` is the server's
 * atomic read-count increment. `tools/read.ts` already calls it once to
 * produce a `resource_link` for a sensitive message. The host
 * materializing that link by fetching the resource is not a SECOND
 * logical read from the agent's point of view, it is the deferred
 * rendering of the read that already happened -- without this cache,
 * `resources/sensitive-message-resource.ts` would call the counting
 * endpoint a second time, and a message deposited with `max_reads: 1` (the
 * natural choice for anything worth marking sensitive) would become
 * unrecoverable through the very resource link this mechanism exists to
 * support.
 *
 * Single-use and short-lived on purpose: `takeCachedOpenedMessage` removes
 * the entry on first read, so a resource fetched twice for the same
 * message only benefits from the cache once (a second fetch legitimately
 * costs a second server read, exactly as it would without this module),
 * and the TTL below bounds how long an entry an agent never materializes
 * can sit in memory.
 */
import type { OpenedMessage } from './resolve-trust.js'

const CACHE_TTL_MS = 5 * 60 * 1000

interface CacheEntry {
	message: OpenedMessage
	expiresAt: number
}

const cache = new Map<string, CacheEntry>()

/** Called by `tools/read.ts` right after it opens a sensitive message and before it returns the `resource_link`. */
export function cacheOpenedSensitiveMessage(messageId: string, message: OpenedMessage): void {
	cache.set(messageId, { message, expiresAt: Date.now() + CACHE_TTL_MS })
}

/**
 * Called by `resources/sensitive-message-resource.ts` before it falls back
 * to a fresh network fetch. Consumes the entry: a `undefined` result means
 * "not cached (process restarted between `read` and this fetch, the TTL
 * elapsed, or nothing was ever cached for this id)", never "cached but
 * empty" -- the caller's fallback path is what still makes the resource
 * work in that case, at the cost of one extra counted read, an accepted
 * residual documented at that call site.
 */
export function takeCachedOpenedMessage(messageId: string): OpenedMessage | undefined {
	const entry = cache.get(messageId)
	if (!entry) return undefined
	cache.delete(messageId)
	if (entry.expiresAt < Date.now()) return undefined
	return entry.message
}
