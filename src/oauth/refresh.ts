/**
 * Refreshes the stored token pair. Called from `ensureValidSession`
 * (oauth/ensure-valid-session.ts) whenever the stored access token is
 * inside its expiry safety margin (token-store.ts's
 * `EXPIRY_SAFETY_MARGIN_MS`), which since `api/mailbox-client.ts` checks
 * the session before every mailbox API call, not just at startup, can be
 * reached concurrently by every sibling instance of this connector running
 * on the same machine. `refresh-lock.ts` serializes the actual refresh
 * across those siblings; this module owns the network call, the
 * invalid_grant recovery path, and writing the result back to
 * `tokens.json`.
 */
import { type Configuration, ResponseBodyError, refreshTokenGrant } from 'openid-client'
import { cliCommand } from '../config/cli-invocation.js'
import { withRefreshLock } from './refresh-lock.js'
import { AGENT_MAILBOX_OAUTH_SCOPE } from './scopes.js'
import {
	type TokenRecord,
	isTokenRecordExpiring,
	readTokenRecord,
	toTokenRecord,
	writeTokenRecord,
} from './token-store.js'

export class NoRefreshTokenError extends Error {
	constructor() {
		super(
			`AIScelle session has no stored refresh token. Run \`${cliCommand('login')}\` again to re-authenticate this device.`,
		)
		this.name = 'NoRefreshTokenError'
	}
}

/**
 * The actual token-endpoint call, run with the refresh lock already held.
 * `before` is the token pair read right before this call was attempted,
 * used only to recognise a sibling process's fresher pair on
 * `invalid_grant` below, never sent to the server itself (`current.
 * refreshToken` is).
 */
async function callTokenEndpoint(configuration: Configuration, before: TokenRecord): Promise<TokenRecord> {
	if (!before.refreshToken) throw new NoRefreshTokenError()

	try {
		const tokens = await refreshTokenGrant(configuration, before.refreshToken)
		const record = toTokenRecord(tokens, before.scope || AGENT_MAILBOX_OAUTH_SCOPE)
		await writeTokenRecord(record)
		return record
	} catch (error) {
		if (error instanceof ResponseBodyError && error.error === 'invalid_grant') {
			// The server's spec section 6.11 rotation doctrine kills the whole
			// refresh token family on reuse: an `invalid_grant` here is exactly
			// what a sibling process racing this very refresh token produces for
			// whichever of them the server sees second. Re-reading `tokens.json`
			// before failing catches that case: if a sibling already wrote a
			// pair newer than `before`, this call lost nothing real, it is only
			// late to observe the winner's result.
			const after = await readTokenRecord()
			if (after && after.obtainedAt > before.obtainedAt) return after
		}
		throw error
	}
}

export async function refreshStoredTokens(configuration: Configuration): Promise<TokenRecord> {
	return withRefreshLock(async () => {
		// Re-read after acquiring the lock: whichever sibling process held it
		// first may already have refreshed while this one waited, in which
		// case the stored pair is fresh again and no network call is needed.
		const current = await readTokenRecord()
		if (!current) throw new NoRefreshTokenError()
		if (!isTokenRecordExpiring(current)) return current

		return callTokenEndpoint(configuration, current)
	})
}
