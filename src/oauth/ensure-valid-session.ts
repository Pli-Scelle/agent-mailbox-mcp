/**
 * The one call `serve` (transport/stdio.ts) makes before it ever connects
 * the MCP transport: resolve this device's registration, make sure the
 * access token handed to the registered tools is not about to expire, and
 * fail with a clear, actionable message otherwise. Nothing here is
 * MCP-specific on purpose: the tool implementations need the exact same
 * `{ configuration, accessToken }` pair to call the mailbox HTTP API, so
 * this is the shared entry point for both.
 */
import type { Configuration } from 'openid-client'
import { loadRegisteredConfiguration } from './discovery.js'
import { refreshStoredTokens } from './refresh.js'
import { isTokenRecordExpiring, readTokenRecord } from './token-store.js'

export class NoSessionError extends Error {
	constructor() {
		super('No AIScelle session on this machine. Run `pliscelle-mcp login` first.')
		this.name = 'NoSessionError'
	}
}

export interface ValidSession {
	configuration: Configuration
	accessToken: string
	clientId: string
}

export async function ensureValidSession(): Promise<ValidSession> {
	const { configuration, record } = await loadRegisteredConfiguration()

	let tokens = await readTokenRecord()
	if (!tokens) throw new NoSessionError()

	if (isTokenRecordExpiring(tokens)) {
		tokens = await refreshStoredTokens(configuration)
	}

	return { configuration, accessToken: tokens.accessToken, clientId: record.clientId }
}
