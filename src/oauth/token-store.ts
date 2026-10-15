/**
 * Local persistence for the token pair, accepting a known risk: the
 * refresh token lands in the same file as the seed, on the same
 * exposure surface, in plaintext, with no passphrase, hardened only by
 * filesystem permissions (config/local-store.ts).
 *
 * `expiresAt` is stored as an absolute ISO timestamp computed from the
 * token response's `expires_in` at the moment it was received, not the
 * relative `expires_in` itself: a relative value would silently mean
 * something different the next time this file is read, since it always
 * describes a duration from response time, never from read time.
 */
import { rm } from 'node:fs/promises'
import { z } from 'zod'
import { readJsonState, writeJsonState } from '../config/local-store.js'
import { tokenStorePath } from '../config/paths.js'

/**
 * Set once a refresh attempt comes back with a definitive OAuth grant
 * error (`oauth/oauth-grant-error.ts`'s `isDefinitiveGrantError`, issue
 * #984): the stored `refreshToken` at that point is confirmed dead, and
 * `ensureValidSession` (oauth/ensure-valid-session.ts) checks this field
 * before ever attempting another refresh, so a dead grant is never
 * replayed against the token endpoint again. Cleared implicitly on the
 * next successful `login`: `toTokenRecord` below never sets it, and
 * `writeTokenRecord` overwrites the whole file, so a fresh token pair
 * carries no leftover `accessLost` from a previous session.
 */
const accessLostRecordSchema = z.object({
	reason: z.string().min(1),
	since: z.string().datetime(),
})

export type AccessLostRecord = z.infer<typeof accessLostRecordSchema>

const tokenRecordSchema = z.object({
	accessToken: z.string().min(1),
	refreshToken: z.string().min(1).optional(),
	scope: z.string(),
	expiresAt: z.string().datetime(),
	obtainedAt: z.string().datetime(),
	accessLost: accessLostRecordSchema.optional(),
})

export type TokenRecord = z.infer<typeof tokenRecordSchema>

export interface TokenEndpointLikeResponse {
	access_token: string
	refresh_token?: string
	scope?: string
	expires_in?: number
}

export function toTokenRecord(response: TokenEndpointLikeResponse, fallbackScope: string): TokenRecord {
	const now = new Date()
	const expiresInSeconds = response.expires_in ?? 0
	return {
		accessToken: response.access_token,
		refreshToken: response.refresh_token,
		scope: response.scope ?? fallbackScope,
		expiresAt: new Date(now.getTime() + expiresInSeconds * 1000).toISOString(),
		obtainedAt: now.toISOString(),
	}
}

/**
 * A rotated pair the disk refused (issue #1941). Once the token endpoint has
 * answered, the server has consumed the refresh token stored on disk, and the
 * new pair exists nowhere else: it is kept here, served to this process in
 * preference to anything older on disk, and written out by the next read the
 * disk accepts. Process memory only, so it dies with the process exactly like
 * any other in-flight credential.
 */
let unpersistedRecord: TokenRecord | undefined

export async function writeTokenRecord(record: TokenRecord): Promise<void> {
	await writeJsonState(tokenStorePath(), record)
	if (unpersistedRecord && record.obtainedAt >= unpersistedRecord.obtainedAt) unpersistedRecord = undefined
}

export async function readTokenRecord(): Promise<TokenRecord | undefined> {
	const stored = await readJsonState(tokenStorePath(), tokenRecordSchema)
	if (!unpersistedRecord) return stored
	if (stored && stored.obtainedAt >= unpersistedRecord.obtainedAt) {
		unpersistedRecord = undefined
		return stored
	}
	const pending = unpersistedRecord
	try {
		await writeTokenRecord(pending)
	} catch {
		// Still refused: this process keeps serving the pair from memory and retries on its next read.
	}
	return pending
}

/**
 * `oauth/refresh.ts`'s write path, once the token endpoint has rotated the
 * pair. When the disk refuses the new pair (ENOSPC, EPERM), the pair is kept
 * in this process (see `unpersistedRecord`), and the stored record is removed
 * if it still carries `consumedRefreshToken`: left on disk, that token would
 * be replayed by a sibling process, and past the server's short replay grace
 * a replay revokes the whole token family, this process's new pair included.
 * Siblings then find no stored session rather than a dead one. The removal is
 * best effort: a directory that refuses the write may refuse it too.
 */
export async function storeRotatedTokenRecord(record: TokenRecord, consumedRefreshToken: string): Promise<void> {
	try {
		await writeTokenRecord(record)
	} catch {
		unpersistedRecord = record
		const stored = await readJsonState(tokenStorePath(), tokenRecordSchema)
		if (stored?.refreshToken === consumedRefreshToken) {
			await rm(tokenStorePath(), { force: true }).catch(() => undefined)
		}
	}
}

/**
 * Merges an `accessLost` marker onto whatever token record is currently
 * stored, called from `ensureValidSession` the moment a refresh attempt
 * fails with a definitive OAuth grant error. Returns `undefined` (and
 * writes nothing) when no record exists at all, which only happens if the
 * store was cleared out from under this process between the read that
 * triggered the refresh and this call.
 */
export async function recordAccessLost(reason: string, at: Date = new Date()): Promise<TokenRecord | undefined> {
	const current = await readTokenRecord()
	if (!current) return undefined

	const record: TokenRecord = { ...current, accessLost: { reason, since: at.toISOString() } }
	await writeTokenRecord(record)
	return record
}

/**
 * A margin, not an exact boundary: `serve` (transport/stdio.ts) checks
 * this at startup, and `ensureValidSession` checks it again before each
 * mailbox API request made through `authorizedFetch` (api/mailbox-client.ts),
 * so a long session refreshes its token mid-session. Refreshing a little early
 * costs one extra token call; a token expiring three seconds into a long
 * session costs a confusing mid-session failure.
 */
const EXPIRY_SAFETY_MARGIN_MS = 60_000

export function isTokenRecordExpiring(record: TokenRecord, now: Date = new Date()): boolean {
	return new Date(record.expiresAt).getTime() - now.getTime() <= EXPIRY_SAFETY_MARGIN_MS
}
