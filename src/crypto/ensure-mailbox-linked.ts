/**
 * The identity-to-mailbox link, run once per process at server startup
 * (transport/stdio.ts), before any of the six tools can do anything
 * useful: this call is what makes a mailbox exist at all for this OAuth
 * subject, or confirms this device's key still matches the one already on
 * record.
 *
 * Idempotent by design on both sides: the server treats the same-key case
 * as an accepted, idempotent no-op, the expected steady-state outcome for
 * a device that already ran this before -- for instance a second device
 * where the user copied over their existing seed file. Calling it again
 * on every `serve` startup costs one HTTP round trip and is the simplest
 * way to guarantee the mailbox exists before `inbox`/`send`/etc. are ever
 * invoked, without inventing a separate "first run" flag this package
 * would then have to keep in sync with server-side reality.
 *
 * The server endpoint is `PUT /agent-mailbox/identity`. It resolves the
 * financing organization itself, from the pairing this device came
 * through, which is why this call still sends no `organizationId`: see
 * api/wire-types.ts's `linkIdentityRequestSchema`.
 */
import { linkMailboxIdentity } from '../api/mailbox-client.js'
import { loadMailboxIdentity } from './mailbox-identity.js'

export async function ensureMailboxLinked(): Promise<void> {
	const identity = await loadMailboxIdentity()
	await linkMailboxIdentity({
		publicKeyX25519: identity.publicKeyX25519Base64,
		publicKeyEd25519: identity.publicKeyEd25519Base64,
	})
}
