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

export async function registerDevice(params: RegisterDeviceParams): Promise<RegisterDeviceResult> {
	const port = await pickFreeLoopbackPort()
	const redirectUri = `http://127.0.0.1:${port}/callback`

	const configuration = await dynamicClientRegistration(
		resolveBackendUrl(),
		{
			client_name: `Pli Scelle AIScelle connector (${params.deviceName}, v${getPackageVersion()})`,
			application_type: 'native',
			redirect_uris: [redirectUri],
			token_endpoint_auth_method: 'none',
			grant_types: ['authorization_code', 'refresh_token', 'urn:ietf:params:oauth:grant-type:device_code'],
			response_types: ['code'],
			scope: AGENT_MAILBOX_OAUTH_SCOPE,
		},
		None(),
		{
			initialAccessToken: params.pairingCode,
			[customFetch]: openidClientFetch,
		},
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
