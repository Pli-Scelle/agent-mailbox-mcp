/**
 * The identity-to-mailbox link: the call that makes a mailbox exist at
 * all for this OAuth subject, registers this device on it, or confirms
 * this device's key still matches the one already on record.
 *
 * Run at two moments, and both are needed: at the end of `login`
 * (cli/login.ts), which is what closes a pairing, and again at every
 * server startup (transport/stdio.ts), before any of the six tools can
 * act. Why the second one alone was not enough: spec 6.2.
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

/** Returns the mailbox address the server holds for this identity. */
export async function ensureMailboxLinked(): Promise<string> {
	const identity = await loadMailboxIdentity()
	const { address } = await linkMailboxIdentity({
		publicKeyX25519: identity.publicKeyX25519Base64,
		publicKeyEd25519: identity.publicKeyEd25519Base64,
	})
	return address
}
