/**
 * RFC 7591 dynamic client registration, gated by a pairing code. Run
 * once per device, by the human, through `pliscelle-mcp pair`
 * (cli/pair.ts) -- never automatically, and never by the MCP server
 * itself: a pairing code is single-use and burns after a handful of
 * failed attempts, so retrying it silently on every `serve` startup
 * would be exactly the kind of behaviour that burns a human's code
 * without their knowledge.
 *
 * Client metadata mirrors the backend's own registration defaults
 * exactly: a public, PKCE-only native client requesting all three of
 * this backend's grant types. The loopback redirect URI is picked once
 * here (loopback-port.ts) and persisted (client-record.ts); the device
 * flow (device-flow.ts) needs no redirect URI at all, so it is
 * unaffected by this choice.
 */
import { Configuration, None, customFetch, dynamicClientRegistration } from 'openid-client'
import { resolveBackendUrl } from '../config/backend-url.js'
import { openidClientFetch } from '../version/backend-client.js'
import { getPackageVersion } from '../version/package-version.js'
import { type ClientRecord, writeClientRecord } from './client-record.js'
import { pickFreeLoopbackPort } from './loopback-port.js'
import { AGENT_MAILBOX_OAUTH_SCOPE } from './scopes.js'

export interface RegisterDeviceParams {
	pairingCode: string
	/** Shown back to the user when they later review this device's connection. */
	deviceName: string
}

export interface RegisterDeviceResult {
	configuration: Configuration
	record: ClientRecord
}

/**
 * Digs the human-readable message out of whatever shape the failure took.
 * Exported for its own tests: this is the difference between telling a user
 * to generate a new code and leaving them staring at a generic failure.
 * Deliberately defensive: an unrecognised shape returns undefined and the
 * caller rethrows the original error untouched, rather than inventing a
 * diagnosis.
 */
export function serverMessageOf(error: unknown): string | undefined {
	if (typeof error !== 'object' || error === null) return undefined
	const body =
		(error as { response?: { body?: unknown }; body?: unknown }).response?.body ??
		(error as { body?: unknown }).body
	if (typeof body === 'string' && body.trim().length > 0) return body.trim()
	if (typeof body === 'object' && body !== null) {
		const candidate =
			(body as Record<string, unknown>).message ?? (body as Record<string, unknown>).error_description
		if (typeof candidate === 'string' && candidate.trim().length > 0) return candidate.trim()
	}
	const cause = (error as { cause?: unknown }).cause
	return cause === undefined ? undefined : serverMessageOf(cause)
}

/**
 * `openid-client` reports a rejected registration as "server responded with
 * an error in the response body" and keeps the server's own explanation in a
 * property nobody thinks to open. That explanation is the only thing that
 * tells a human what to do next, and this is the very first command they
 * ever run: an expired pairing code and a server outage must not look alike.
 *
 * So the server's message is surfaced verbatim when there is one, and the
 * original error is chained for anyone debugging deeper.
 */
async function registerOrExplain(
	metadata: Parameters<typeof dynamicClientRegistration>[1],
	pairingCode: string,
): Promise<Configuration> {
	try {
		return await dynamicClientRegistration(resolveBackendUrl(), metadata, None(), {
			initialAccessToken: pairingCode,
			[customFetch]: openidClientFetch,
		})
	} catch (error: unknown) {
		const served = serverMessageOf(error)
		if (!served) throw error
		throw new Error(
			`AIScelle refused this pairing code: ${served}\nGenerate a new one from the AIScelle tab in your Pli Scelle account. A code lasts fifteen minutes, works once, and burns after a few failed attempts.`,
			{ cause: error },
		)
	}
}

export async function registerDevice(params: RegisterDeviceParams): Promise<RegisterDeviceResult> {
	const port = await pickFreeLoopbackPort()
	const redirectUri = `http://127.0.0.1:${port}/callback`

	const configuration = await registerOrExplain(
		{
			client_name: `Pli Scelle AIScelle connector (${params.deviceName}, v${getPackageVersion()})`,
			application_type: 'native',
			redirect_uris: [redirectUri],
			token_endpoint_auth_method: 'none',
			grant_types: ['authorization_code', 'refresh_token', 'urn:ietf:params:oauth:grant-type:device_code'],
			response_types: ['code'],
			scope: AGENT_MAILBOX_OAUTH_SCOPE,
		},
		params.pairingCode,
	)

	const clientId = configuration.clientMetadata().client_id
	if (!clientId) {
		throw new Error('AIScelle registration succeeded but the authorization server returned no client_id.')
	}

	const record: ClientRecord = {
		clientId,
		redirectUri,
		registeredAt: new Date().toISOString(),
	}
	await writeClientRecord(record)

	return { configuration, record }
}
