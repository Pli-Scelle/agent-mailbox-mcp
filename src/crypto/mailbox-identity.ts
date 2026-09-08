/**
 * This device's own mailbox key material: the seed, derived once per
 * process and cached (deriving is cheap, but there is no reason to redo it
 * per tool call), plus the address it implies. Every tool that signs,
 * decrypts or seals (send, read, and the sensitive-content resource
 * handler) goes through this module rather than calling
 * `crypto/seed-store.ts` and `deriveMailboxKeys` directly, so there is one
 * place this package holds live key material in memory.
 */
import {
	type AgentMailboxKeyMaterial,
	computeMailboxAddress,
	deriveMailboxKeys,
	encodeKeyMaterial,
} from './envelope-crypto.js'
import { ensureMailboxSeed } from './seed-store.js'

export interface MailboxIdentity {
	keys: AgentMailboxKeyMaterial
	/** Base64, the wire encoding every AIScelle field uses (envelope-crypto.ts's `encodeKeyMaterial`). */
	publicKeyX25519Base64: string
	publicKeyEd25519Base64: string
	address: string
}

let cachedIdentity: MailboxIdentity | undefined

export async function loadMailboxIdentity(): Promise<MailboxIdentity> {
	if (cachedIdentity) return cachedIdentity

	const seed = await ensureMailboxSeed()
	const keys = deriveMailboxKeys(seed)
	const publicKeyX25519Base64 = encodeKeyMaterial(keys.x25519.publicKeyRaw)
	const publicKeyEd25519Base64 = encodeKeyMaterial(keys.ed25519.publicKeyRaw)

	cachedIdentity = {
		keys,
		publicKeyX25519Base64,
		publicKeyEd25519Base64,
		address: computeMailboxAddress(publicKeyX25519Base64),
	}
	return cachedIdentity
}
