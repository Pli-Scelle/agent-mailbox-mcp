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
import { z } from 'zod'
import { readJsonState, writeJsonState } from '../config/local-store.js'
import { tokenStorePath } from '../config/paths.js'

const tokenRecordSchema = z.object({
	accessToken: z.string().min(1),
	refreshToken: z.string().min(1).optional(),
	scope: z.string(),
	expiresAt: z.string().datetime(),
	obtainedAt: z.string().datetime(),
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

export async function readTokenRecord(): Promise<TokenRecord | undefined> {
	return readJsonState(tokenStorePath(), tokenRecordSchema)
}

export async function writeTokenRecord(record: TokenRecord): Promise<void> {
	await writeJsonState(tokenStorePath(), record)
}

/**
 * A margin, not an exact boundary: `serve` (transport/stdio.ts) checks
 * this once at startup, and an MCP stdio session can run for a long time
 * afterwards with no further check point before later tools exist to
 * fail a call on an expired token and trigger a refresh themselves.
 * Refreshing a little early costs one extra token call; a token
 * expiring three seconds into a long session costs a confusing
 * mid-session failure. This module only spends the margin at the one
 * checkpoint it owns (startup); the "refresh transparently mid-session"
 * behaviour belongs to whichever future addition calls the mailbox API
 * from a tool.
 */
const EXPIRY_SAFETY_MARGIN_MS = 60_000

export function isTokenRecordExpiring(record: TokenRecord, now: Date = new Date()): boolean {
	return new Date(record.expiresAt).getTime() - now.getTime() <= EXPIRY_SAFETY_MARGIN_MS
}
