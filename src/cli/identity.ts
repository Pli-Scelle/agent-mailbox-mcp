/**
 * `pliscelle-mcp identity`: prints what this device hands to a
 * correspondent so they can authorize it, its address and its Ed25519
 * public key.
 *
 * Without this the allowlist cannot be filled at all. The back-office
 * form (spec section 12.3) asks for "l'adresse et la clé publique que
 * son correspondant lui a transmises", and until this command existed no
 * surface of the product showed anyone their own signature key: the
 * management tab's DTO excludes both public keys on purpose (12.2), and
 * the lookup route resolves an address into the X25519 encryption key,
 * which is a different key and answers a different question.
 *
 * Read locally from the seed, never fetched from the server, and that is
 * the point rather than a convenience: section 5.3 makes every device
 * ratify its own allowlist so that what a device trusts does not come
 * from our servers. A key collected from the server to be pasted into a
 * correspondent's allowlist would reopen through a side door what
 * ratification exists to close.
 *
 * Human-run, never an MCP tool, on the same terms as `ratify` and
 * `policy`. A public key is not a secret, so the stake is lower here,
 * but an identity command an agent can call is one more thing a
 * successful injection can drive.
 *
 * Works on a device that was never paired: `ensureMailboxSeed` creates
 * the seed on first read, and the address it implies is stable from that
 * moment on, whether or not the mailbox has ever been linked
 * server-side.
 */
import { type MailboxIdentity, loadMailboxIdentity } from '../crypto/mailbox-identity.js'
import { printUsageAndExit } from './usage.js'

/**
 * Kept pure and separate from the command so a test can assert on what
 * the output does NOT contain: the seed and the private keys never reach
 * a line of it. `keys` carries live private key material, and this
 * function reads only the two public members beside it.
 */
export function formatIdentityOutput(identity: MailboxIdentity): string {
	return [
		`Address:              ${identity.address}`,
		`Public key (Ed25519): ${identity.publicKeyEd25519Base64}`,
		'',
		'Give both to a correspondent so they can authorize you in their AIScelle tab.',
	].join('\n')
}

export async function runIdentityCommand(argv: Array<string>): Promise<void> {
	// Checked here rather than through `parseArgs`: the command takes no
	// option at all, so the only useful answer to any argument is the
	// usage screen, and routing that through an option parser with an
	// empty option set would only turn it into a thrown `TypeError` to
	// translate back.
	if (argv.length > 0) {
		printUsageAndExit('identity: this command takes no arguments.')
	}

	console.log(formatIdentityOutput(await loadMailboxIdentity()))
}
