/**
 * The one call `api/mailbox-client.ts`'s `authorizedFetch` makes before
 * every mailbox API request, and `transport/stdio.ts` makes once at
 * startup: resolve this device's registration, make sure the access token
 * handed to the caller is not about to expire, and fail with a clear,
 * actionable message otherwise. Nothing here is MCP-specific on purpose:
 * the tool implementations need the exact same `{ configuration,
 * accessToken }` pair to call the mailbox HTTP API, so this is the shared
 * entry point for both.
 *
 * A definitive OAuth grant error (`oauth-grant-error.ts`'s
 * `isDefinitiveGrantError`, issue #984) is never retried: the failure is
 * recorded once in `token-store.ts` (`recordAccessLost`), and every call
 * afterwards, from this process or a later one reading the same store,
 * throws `AccessLostError` immediately, without ever reaching the token
 * endpoint again. A transitory failure (network, 5xx, timeout) keeps using
 * `refresh-backoff.ts`'s growing, capped delay, unchanged from before this
 * distinction existed.
 */
import type { Configuration } from 'openid-client'
import { cliCommand } from '../config/cli-invocation.js'
import { loadRegisteredConfiguration } from './discovery.js'
import { isDefinitiveGrantError } from './oauth-grant-error.js'
import { recordRefreshFailure, recordRefreshSuccess, refreshBackoffRemainingMs } from './refresh-backoff.js'
import { refreshStoredTokens } from './refresh.js'
import { isTokenRecordExpiring, readTokenRecord, recordAccessLost } from './token-store.js'

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

/**
 * Thrown once a refresh attempt has come back with a definitive OAuth
 * grant error: the stored refresh token is confirmed dead, recorded as
 * such in `token-store.ts`, and never sent to the token endpoint again.
 * Every tool call reaching this (through `authorizedFetch`) surfaces the
 * exact same `since`/`reason` pair for as long as the device stays
 * unauthenticated, so an agent asking twice sees the same answer twice,
 * never a fresh guess.
 */
export class AccessLostError extends Error {
	readonly reason: string
	readonly since: string

	constructor(reason: string, since: string) {
		super(
			`AIScelle access was revoked on ${since} (${reason}). Run \`${cliCommand('login')}\` again to restore it.`,
		)
		this.name = 'AccessLostError'
		this.reason = reason
		this.since = since
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

	if (tokens.accessLost) throw new AccessLostError(tokens.accessLost.reason, tokens.accessLost.since)

	if (isTokenRecordExpiring(tokens)) {
		const remainingMs = refreshBackoffRemainingMs()
		if (remainingMs > 0) throw new RefreshBackedOffError(remainingMs)

		try {
			tokens = await refreshStoredTokens(configuration)
			recordRefreshSuccess()
		} catch (error) {
			if (isDefinitiveGrantError(error)) {
				const lost = await recordAccessLost(error.error)
				if (lost?.accessLost) throw new AccessLostError(lost.accessLost.reason, lost.accessLost.since)
				throw error
			}

			recordRefreshFailure()
			throw error
		}
	}

	return { configuration, accessToken: tokens.accessToken, clientId: record.clientId }
}
