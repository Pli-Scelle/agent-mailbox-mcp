/**
 * The one thing this connector must remember about ITSELF once RFC 7591
 * dynamic registration succeeds: the `client_id` the authorization server
 * assigned it, and the exact loopback redirect URI it registered under.
 *
 * The redirect URI is fixed at registration time and reused for every
 * later `login`, rather than chosen fresh per attempt: `oidc-provider`
 * matches `redirect_uri` by exact string
 * (verified at `oidc-provider@9.11.5`'s
 * `lib/actions/authorization/check_redirect_uri.js`, `Client#
 * redirectUriAllowed` -- no RFC 8252 §7.3 loopback port-wildcarding is
 * implemented server-side), so a login flow that picked a new random port
 * every time would need to re-register a new client on every single login,
 * which is not how RFC 7591 registration or this backend's pairing-code
 * gate (one code, one registration) are meant to be used. Binding one
 * loopback port for the lifetime of this client record
 * is the standard resolution native-app OAuth clients use for exactly this
 * constraint.
 */
import { z } from 'zod'
import { readJsonState, writeJsonState } from '../config/local-store.js'
import { clientRecordPath } from '../config/paths.js'

const clientRecordSchema = z.object({
	clientId: z.string().min(1),
	redirectUri: z.string().url(),
	registeredAt: z.string().datetime(),
})

export type ClientRecord = z.infer<typeof clientRecordSchema>

export async function readClientRecord(): Promise<ClientRecord | undefined> {
	return readJsonState(clientRecordPath(), clientRecordSchema)
}

export async function writeClientRecord(record: ClientRecord): Promise<void> {
	await writeJsonState(clientRecordPath(), record)
}

export class NoClientRegisteredError extends Error {
	constructor() {
		super(
			'No AIScelle device registration found on this machine. Run `pliscelle-mcp pair --code <PAIRING_CODE>` first (obtain a code from the AIScelle tab in your Pli Scelle account), then `pliscelle-mcp login`.',
		)
		this.name = 'NoClientRegisteredError'
	}
}

export async function requireClientRecord(): Promise<ClientRecord> {
	const record = await readClientRecord()
	if (!record) throw new NoClientRegisteredError()
	return record
}
