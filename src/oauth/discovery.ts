/**
 * Rebuilds an `openid-client` `Configuration` for a client this machine
 * already registered (pairing-registration.ts, a previous run). Every
 * command except `pair` itself starts here: `login` needs it to build the
 * authorization URL or start the device flow, and `serve` needs it to
 * refresh a near-expiry access token before handing control to the MCP
 * transport.
 */
import { Configuration, None, customFetch, discovery } from 'openid-client'
import { resolveBackendUrl } from '../config/backend-url.js'
import { openidClientFetch } from '../version/backend-client.js'
import { type ClientRecord, requireClientRecord } from './client-record.js'

export interface LoadedConfiguration {
	configuration: Configuration
	record: ClientRecord
}

export async function loadRegisteredConfiguration(): Promise<LoadedConfiguration> {
	const record = await requireClientRecord()

	const configuration = await discovery(
		resolveBackendUrl(),
		record.clientId,
		{ token_endpoint_auth_method: 'none' },
		None(),
		{ [customFetch]: openidClientFetch },
	)

	return { configuration, record }
}
