/**
 * Refreshes the stored token pair. Its one caller is the `serve` startup
 * path (transport/stdio.ts), which must not hand a near-expiry access
 * token to a session that can run for a long time afterwards
 * (token-store.ts's `EXPIRY_SAFETY_MARGIN_MS` docblock explains why
 * refreshing mid-session is out of scope here).
 */
import { type Configuration, refreshTokenGrant } from 'openid-client'
import { AGENT_MAILBOX_OAUTH_SCOPE } from './scopes.js'
import { type TokenRecord, readTokenRecord, toTokenRecord, writeTokenRecord } from './token-store.js'

export class NoRefreshTokenError extends Error {
	constructor() {
		super(
			'AIScelle session has no stored refresh token. Run `pliscelle-mcp login` again to re-authenticate this device.',
		)
		this.name = 'NoRefreshTokenError'
	}
}

export async function refreshStoredTokens(configuration: Configuration): Promise<TokenRecord> {
	const current = await readTokenRecord()
	if (!current?.refreshToken) throw new NoRefreshTokenError()

	const tokens = await refreshTokenGrant(configuration, current.refreshToken)
	const record = toTokenRecord(tokens, current.scope || AGENT_MAILBOX_OAUTH_SCOPE)
	await writeTokenRecord(record)
	return record
}
