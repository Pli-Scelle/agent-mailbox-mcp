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

/**
 * How long a discovered configuration is reused before the next network
 * discovery. `ensureValidSession` runs before every mailbox request and every
 * heartbeat (issue #1939); the issuer's metadata changes on a deployment, not
 * between two requests. An hour bounds how long a changed endpoint can go
 * unnoticed, at one discovery per hour per process instead of one per call.
 */
const CONFIGURATION_TTL_MS = 60 * 60 * 1000

interface CachedConfiguration {
	configuration: Promise<Configuration>
	expiresAt: number
}

/** Keyed by backend URL and client id: a new `pair` registers another client, which gets its own entry. */
const configurationCache = new Map<string, CachedConfiguration>()

function discoverConfiguration(backendUrl: URL, clientId: string): Promise<Configuration> {
	const key = `${backendUrl.href}\n${clientId}`
	const cached = configurationCache.get(key)
	if (cached && cached.expiresAt > Date.now()) return cached.configuration

	const configuration = discovery(backendUrl, clientId, { token_endpoint_auth_method: 'none' }, None(), {
		[customFetch]: openidClientFetch,
	})
	const entry: CachedConfiguration = { configuration, expiresAt: Date.now() + CONFIGURATION_TTL_MS }
	configurationCache.set(key, entry)
	// A failed discovery is never served from the cache: the next call tries the network again.
	configuration.catch(() => {
		if (configurationCache.get(key) === entry) configurationCache.delete(key)
	})
	return configuration
}

export async function loadRegisteredConfiguration(): Promise<LoadedConfiguration> {
	const record = await requireClientRecord()
	const configuration = await discoverConfiguration(resolveBackendUrl(), record.clientId)
	return { configuration, record }
}
