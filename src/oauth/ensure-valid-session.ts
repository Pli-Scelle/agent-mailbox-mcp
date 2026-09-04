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
import { cliCommand } from '../config/cli-invocation.js'
import { loadRegisteredConfiguration } from './discovery.js'
import { recordRefreshFailure, recordRefreshSuccess, refreshBackoffRemainingMs } from './refresh-backoff.js'
import { refreshStoredTokens } from './refresh.js'
import { isTokenRecordExpiring, readTokenRecord } from './token-store.js'

export class NoSessionError extends Error {
	constructor() {
		super(`No AIScelle session on this machine. Run \`${cliCommand('login')}\` first.`)
		this.name = 'NoSessionError'
	}
}

/**
 * Thrown instead of even attempting a refresh while `refresh-backoff.ts`'s
 * shared state is in its backoff window: this is what stops the heartbeat's
 * 60s timer (server/heartbeat.ts, reached here through every
 * `authorizedFetch` call in api/mailbox-client.ts) from re-hitting a token
 * endpoint that just refused this process's last few attempts.
 */
export class RefreshBackedOffError extends Error {
	constructor(remainingMs: number) {
		super(
			`AIScelle session refresh is backed off after repeated failures, retrying automatically in ${Math.ceil(remainingMs / 1000)}s. If this persists, run \`${cliCommand('login')}\` again to re-authenticate this device.`,
		)
		this.name = 'RefreshBackedOffError'
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
		const remainingMs = refreshBackoffRemainingMs()
		if (remainingMs > 0) throw new RefreshBackedOffError(remainingMs)

		try {
			tokens = await refreshStoredTokens(configuration)
			recordRefreshSuccess()
		} catch (error) {
			recordRefreshFailure()
			throw error
		}
	}

	return { configuration, accessToken: tokens.accessToken, clientId: record.clientId }
}
