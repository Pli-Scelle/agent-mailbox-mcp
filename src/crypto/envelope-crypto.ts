/**
 * AIScelle asymmetric transport cryptography, device ("poste") side.
 *
 * This is a faithful port of the server's own reference implementation of
 * this cryptography. It is a PORT, not an import: `agent-mailbox-mcp` is
 * the first public artifact of this product and must never depend on the
 * private backend, which is never published. Every constant, label and
 * wire-format detail below (HKDF info strings, PKCS8 DER wrapping,
 * AES-256-GCM framing, the length-prefixed signature payload) is copied
 * verbatim from that reference implementation so the two sides of the
 * protocol agree byte for byte; a drift here would surface immediately as
 * every signature verification and every decryption failing, never
 * silently.
 *
 * Scope: only the functions a DEVICE genuinely calls are ported.
 * The two anti-replay checks (verifying a stored signature, and rejecting
 * a replayed or stale message) are deposit-time, server-only concerns and
 * stay out of this file on purpose: a device never re-runs the server's
 * own deposit checks, it runs `resolveTrustFromSignature` at read time
 * instead.
 */
import {
	type KeyObject,
	createCipheriv,
	createDecipheriv,
	createHash,
	createPrivateKey,
	createPublicKey,
	diffieHellman,
	generateKeyPairSync,
	hkdfSync,
	randomBytes,
	sign,
	verify,
} from 'node:crypto'

export class AgentMailboxCryptoError extends Error {
	constructor(message: string, options?: { cause?: unknown }) {
		super(message, options)
		this.name = 'AgentMailboxCryptoError'
	}
}

/** 4.1, the keys. */

export const SEED_BYTES = 32
export const AES_KEY_BYTES = 32
export const AES_GCM_IV_BYTES = 12
export const AES_GCM_TAG_BYTES = 16

/**
 * Domain-separation labels for HKDF-SHA256: distinct, versioned domain
 * labels, `aiscelle/x25519/v1` and `aiscelle/ed25519/v1`. Must match the
 * server's own reference implementation exactly: any drift derives two
 * different key pairs from the same seed than that reference
 * implementation would, which the shared test vector
 * (test/envelope-crypto.spec.ts) exists to catch.
 */
export const X25519_HKDF_INFO = 'aiscelle/x25519/v1'
export const ED25519_HKDF_INFO = 'aiscelle/ed25519/v1'

/** Sealing-key derivation label. Matches the server's own `SEAL_HKDF_INFO`. */
export const SEAL_HKDF_INFO = 'aiscelle/seal/v1'

/**
 * Envelope format version byte. Matches the server's own
 * `AGENT_MAILBOX_FORMAT_VERSION`.
 */
export const AGENT_MAILBOX_FORMAT_VERSION = 0x01

/**
 * PKCS8 `OneAsymmetricKey` DER prefixes for a raw 32-byte X25519/Ed25519
 * private key, as defined by RFC 8410. This is a fixed, parameter-less
 * ASN.1 structure, not a value specific to any particular implementation,
 * and is reproduced here unchanged from the server's own reference
 * implementation.
 */
const X25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b656e04220420', 'hex')
const ED25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex')

/** A mailbox has a 32-byte seed drawn on the device with `crypto.randomBytes(32)`. */
export function generateMailboxSeed(): Buffer {
	return randomBytes(SEED_BYTES)
}

function deriveRawKeyMaterial(ikm: Buffer, info: string, length: number): Buffer {
	return Buffer.from(hkdfSync('sha256', ikm, Buffer.alloc(0), Buffer.from(info, 'utf8'), length))
}

function exportRawPublicKey(publicKey: KeyObject): Buffer {
	const jwk = publicKey.export({ format: 'jwk' }) as { x?: string }
	if (!jwk.x) {
		throw new AgentMailboxCryptoError('OKP public key export did not carry a JWK "x" member')
	}
	return Buffer.from(jwk.x, 'base64url')
}

function importOkpPublicKeyFromRaw(crv: 'X25519' | 'Ed25519', raw: Buffer): KeyObject {
	if (raw.length !== 32) {
		throw new AgentMailboxCryptoError(`${crv} public key must be exactly 32 bytes, got ${raw.length}`)
	}
	return createPublicKey({ key: { kty: 'OKP', crv, x: raw.toString('base64url') }, format: 'jwk' })
}

export interface AgentMailboxKeyPair {
	privateKey: KeyObject
	publicKey: KeyObject
	publicKeyRaw: Buffer
}

export interface AgentMailboxKeyMaterial {
	x25519: AgentMailboxKeyPair
	ed25519: AgentMailboxKeyPair
}

/**
 * Derives the mailbox's X25519 (encryption) and Ed25519 (signature) key
 * pairs from its seed. This is the ONE function in this file a device runs
 * against its own real seed; the server never calls its mirror of this
 * function against a real seed, since it never possesses one.
 */
export function deriveMailboxKeys(seed: Buffer): AgentMailboxKeyMaterial {
	if (seed.length !== SEED_BYTES) {
		throw new AgentMailboxCryptoError(`mailbox seed must be exactly ${SEED_BYTES} bytes, got ${seed.length}`)
	}

	const x25519Scalar = deriveRawKeyMaterial(seed, X25519_HKDF_INFO, 32)
	const ed25519Seed = deriveRawKeyMaterial(seed, ED25519_HKDF_INFO, 32)

	const x25519PrivateKey = createPrivateKey({
		key: Buffer.concat([X25519_PKCS8_PREFIX, x25519Scalar]),
		format: 'der',
		type: 'pkcs8',
	})
	const ed25519PrivateKey = createPrivateKey({
		key: Buffer.concat([ED25519_PKCS8_PREFIX, ed25519Seed]),
		format: 'der',
		type: 'pkcs8',
	})

	const x25519PublicKey = createPublicKey(x25519PrivateKey)
	const ed25519PublicKey = createPublicKey(ed25519PrivateKey)

	return {
		x25519: {
			privateKey: x25519PrivateKey,
			publicKey: x25519PublicKey,
			publicKeyRaw: exportRawPublicKey(x25519PublicKey),
		},
		ed25519: {
			privateKey: ed25519PrivateKey,
			publicKey: ed25519PublicKey,
			publicKeyRaw: exportRawPublicKey(ed25519PublicKey),
		},
	}
}

/**
 * Every binary field on the wire (public keys, ciphertext blocks, sealed
 * key, ephemeral key, signature) is base64, never raw bytes over JSON.
 * Matches the server's own `encodeKeyMaterial`/`decodeKeyMaterial`, the
 * single encode/decode point both sides of the protocol share.
 */
export function encodeKeyMaterial(raw: Buffer): string {
	return raw.toString('base64')
}

export function decodeKeyMaterial(encoded: string): Buffer {
	return Buffer.from(encoded, 'base64')
}

/**
 * A mailbox's public address is the SHA-256 fingerprint of its X25519
 * public key, base32 encoded and prefixed. Ported from the server's own
 * address-computation logic: same alphabet
 * (`ABCDEFGHIJKLMNOPQRSTUVWXYZ234567`, standard RFC 4648 base32,
 * deliberately NOT the pairing code's ambiguity-free alphabet, since an
 * address is never hand-typed), same `aisc_` prefix, and, critically, the
 * same input encoding: the server hashes the base64 STRING form of the
 * public key, not the decoded raw bytes, so this function does the same to
 * compute an identical address for the same key.
 */
const ADDRESS_BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
const ADDRESS_PREFIX = 'aisc_'

function base32Encode(bytes: Buffer): string {
	let bits = 0
	let value = 0
	let output = ''
	for (const byte of bytes) {
		value = (value << 8) | byte
		bits += 8
		while (bits >= 5) {
			output += ADDRESS_BASE32_ALPHABET[(value >>> (bits - 5)) & 31]
			bits -= 5
		}
	}
	if (bits > 0) {
		output += ADDRESS_BASE32_ALPHABET[(value << (5 - bits)) & 31]
	}
	return output
}

export function computeMailboxAddress(publicKeyX25519Base64: string): string {
	const digest = createHash('sha256').update(publicKeyX25519Base64, 'utf8').digest()
	return `${ADDRESS_PREFIX}${base32Encode(digest).toLowerCase()}`
}

/** 4.2, the envelope of a message. */

export function generateContentKey(): Buffer {
	return randomBytes(AES_KEY_BYTES)
}

export interface EncryptedBlock {
	ciphertext: Buffer
	iv: Buffer
}

/** Encrypts one envelope block (header or body). Output: `[FORMAT_VERSION][AES-GCM output][tag]`. */
export function encryptBlock(key: Buffer, plaintext: Buffer): EncryptedBlock {
	if (key.length !== AES_KEY_BYTES) {
		throw new AgentMailboxCryptoError(`content key must be exactly ${AES_KEY_BYTES} bytes, got ${key.length}`)
	}
	const iv = randomBytes(AES_GCM_IV_BYTES)
	const cipher = createCipheriv('aes-256-gcm', key, iv)
	const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()])
	const tag = cipher.getAuthTag()
	const ciphertext = Buffer.concat([Buffer.from([AGENT_MAILBOX_FORMAT_VERSION]), encrypted, tag])
	return { ciphertext, iv }
}

/**
 * Decrypts one envelope block. Throws on an unsupported format version or a
 * failed GCM tag: a wrong key and a single altered byte both land here,
 * indistinguishably -- a single altered byte in a ciphertext block is
 * always rejected.
 */
export function decryptBlock(key: Buffer, ciphertext: Buffer, iv: Buffer): Buffer {
	if (key.length !== AES_KEY_BYTES) {
		throw new AgentMailboxCryptoError(`content key must be exactly ${AES_KEY_BYTES} bytes, got ${key.length}`)
	}
	if (ciphertext.length < 1 + AES_GCM_TAG_BYTES) {
		throw new AgentMailboxCryptoError('block ciphertext is truncated')
	}
	const version = ciphertext[0]
	if (version !== AGENT_MAILBOX_FORMAT_VERSION) {
		throw new AgentMailboxCryptoError(`unsupported block format version ${version}`)
	}
	const tag = ciphertext.subarray(ciphertext.length - AES_GCM_TAG_BYTES)
	const body = ciphertext.subarray(1, ciphertext.length - AES_GCM_TAG_BYTES)
	try {
		const decipher = createDecipheriv('aes-256-gcm', key, iv, { authTagLength: AES_GCM_TAG_BYTES })
		decipher.setAuthTag(tag)
		return Buffer.concat([decipher.update(body), decipher.final()])
	} catch (error) {
		throw new AgentMailboxCryptoError('block authentication failed', { cause: error })
	}
}

function sealWithEmbeddedIv(key: Buffer, plaintext: Buffer): Buffer {
	const iv = randomBytes(AES_GCM_IV_BYTES)
	const cipher = createCipheriv('aes-256-gcm', key, iv)
	const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()])
	const tag = cipher.getAuthTag()
	return Buffer.concat([Buffer.from([AGENT_MAILBOX_FORMAT_VERSION]), iv, encrypted, tag])
}

function unsealWithEmbeddedIv(key: Buffer, sealed: Buffer): Buffer {
	const minLength = 1 + AES_GCM_IV_BYTES + AES_GCM_TAG_BYTES
	if (sealed.length < minLength) {
		throw new AgentMailboxCryptoError('sealed content key is truncated')
	}
	const version = sealed[0]
	if (version !== AGENT_MAILBOX_FORMAT_VERSION) {
		throw new AgentMailboxCryptoError(`unsupported seal format version ${version}`)
	}
	const iv = sealed.subarray(1, 1 + AES_GCM_IV_BYTES)
	const tag = sealed.subarray(sealed.length - AES_GCM_TAG_BYTES)
	const ciphertext = sealed.subarray(1 + AES_GCM_IV_BYTES, sealed.length - AES_GCM_TAG_BYTES)
	try {
		const decipher = createDecipheriv('aes-256-gcm', key, iv, { authTagLength: AES_GCM_TAG_BYTES })
		decipher.setAuthTag(tag)
		return Buffer.concat([decipher.update(ciphertext), decipher.final()])
	} catch (error) {
		throw new AgentMailboxCryptoError('sealed content key authentication failed', { cause: error })
	}
}

export interface SealedContentKey {
	sealedKey: Buffer
	ephemeralPublicKey: Buffer
}

/** Seals a message's content key for one recipient mailbox. Used by `send` (tools/send.ts). */
export function sealContentKey(recipientPublicKeyX25519Raw: Buffer, contentKey: Buffer): SealedContentKey {
	const ephemeral = generateKeyPairSync('x25519')
	const recipientPublicKey = importOkpPublicKeyFromRaw('X25519', recipientPublicKeyX25519Raw)
	const sharedSecret = diffieHellman({ privateKey: ephemeral.privateKey, publicKey: recipientPublicKey })
	const sealingKey = deriveRawKeyMaterial(sharedSecret, SEAL_HKDF_INFO, AES_KEY_BYTES)
	return {
		sealedKey: sealWithEmbeddedIv(sealingKey, contentKey),
		ephemeralPublicKey: exportRawPublicKey(ephemeral.publicKey),
	}
}

/**
 * Opens a sealed content key with the mailbox's own X25519 private key.
 * Used by `read` (tools/read.ts) and by the sensitive-content resource
 * handler (resources/sensitive-message-resource.ts). Throws when this
 * device is not the intended recipient: decryption with the wrong key
 * fails GCM authentication against the wrong derived sealing key.
 */
export function openSealedKey(
	recipientPrivateKeyX25519: KeyObject,
	ephemeralPublicKeyRaw: Buffer,
	sealedKey: Buffer,
): Buffer {
	const ephemeralPublicKey = importOkpPublicKeyFromRaw('X25519', ephemeralPublicKeyRaw)
	const sharedSecret = diffieHellman({ privateKey: recipientPrivateKeyX25519, publicKey: ephemeralPublicKey })
	const sealingKey = deriveRawKeyMaterial(sharedSecret, SEAL_HKDF_INFO, AES_KEY_BYTES)
	return unsealWithEmbeddedIv(sealingKey, sealedKey)
}

/**
 * The fields the signature covers: the recipient's address, the message
 * identifier, the fingerprints of both blocks, the requested expiration,
 * and a freshness timestamp. Identical shape to the server's own
 * `EnvelopeSignaturePayload`.
 */
export interface EnvelopeSignaturePayload {
	recipientAddress: string
	messageUid: string
	headerCiphertext: Buffer
	bodyCiphertext: Buffer
	requestedExpiresAt: string
	freshnessTimestamp: string
}

function uint32BE(n: number): Buffer {
	const buf = Buffer.alloc(4)
	buf.writeUInt32BE(n, 0)
	return buf
}

/**
 * Same six signed fields as `EnvelopeSignaturePayload`, but the two block
 * fingerprints are supplied pre-hashed rather than as the full ciphertext
 * buffers. Client-only addition, no server counterpart: it exists so
 * `resolve-trust.ts` can verify a message's signature from an `inbox`/
 * `search` HEADER listing alone, since listing a mailbox only fetches
 * headers and never downloads bodies for a search, which by definition
 * never has the body ciphertext bytes to hash locally. The server
 * supplies `bodyCiphertextSha256` pre-computed in that listing response
 * instead (api/wire-types.ts's own doc comment on
 * `messageHeaderEntrySchema`); `buildEnvelopeSignaturePayloadFromDigests`
 * produces byte-identical output to `buildEnvelopeSignaturePayload` given
 * the hash of the same ciphertext, which `test/envelope-crypto.spec.ts`
 * proves directly.
 */
export interface EnvelopeSignaturePayloadDigests {
	recipientAddress: string
	messageUid: string
	headerCiphertextSha256: Buffer
	bodyCiphertextSha256: Buffer
	requestedExpiresAt: string
	freshnessTimestamp: string
}

function buildSignedFields(payload: {
	recipientAddress: string
	messageUid: string
	headerCiphertextSha256: Buffer
	bodyCiphertextSha256: Buffer
	requestedExpiresAt: string
	freshnessTimestamp: string
}): Buffer {
	const fields = [
		Buffer.from(payload.recipientAddress, 'utf8'),
		Buffer.from(payload.messageUid, 'utf8'),
		payload.headerCiphertextSha256,
		payload.bodyCiphertextSha256,
		Buffer.from(payload.requestedExpiresAt, 'utf8'),
		Buffer.from(payload.freshnessTimestamp, 'utf8'),
	]
	return Buffer.concat(fields.flatMap((field) => [uint32BE(field.length), field]))
}

/**
 * Canonical, length-prefixed serialization of the signed fields. Must byte-
 * for-byte match the server's own `buildEnvelopeSignaturePayload`, since a
 * device signs with this and the server verifies at deposit with its own
 * copy: any difference and every deposit from this package would be
 * refused as an invalid signature.
 */
export function buildEnvelopeSignaturePayload(payload: EnvelopeSignaturePayload): Buffer {
	return buildSignedFields({
		recipientAddress: payload.recipientAddress,
		messageUid: payload.messageUid,
		headerCiphertextSha256: createHash('sha256').update(payload.headerCiphertext).digest(),
		bodyCiphertextSha256: createHash('sha256').update(payload.bodyCiphertext).digest(),
		requestedExpiresAt: payload.requestedExpiresAt,
		freshnessTimestamp: payload.freshnessTimestamp,
	})
}

/** See `EnvelopeSignaturePayloadDigests`'s doc comment: the header-only-listing verification path. */
export function buildEnvelopeSignaturePayloadFromDigests(payload: EnvelopeSignaturePayloadDigests): Buffer {
	return buildSignedFields(payload)
}

/** Signs an envelope: the whole set of fields is signed in Ed25519 by the sender. Used by `send`. */
export function signEnvelope(senderPrivateKeyEd25519: KeyObject, payload: EnvelopeSignaturePayload): Buffer {
	return sign(null, buildEnvelopeSignaturePayload(payload), senderPrivateKeyEd25519)
}

/**
 * Verifies an envelope signature against one candidate Ed25519 public key.
 * Never throws: a malformed signature or key mismatch both resolve to
 * `false`, so `resolveTrustFromSignature` below can try every candidate
 * uniformly.
 */
export function verifyEnvelopeSignature(
	senderPublicKeyEd25519: KeyObject,
	payload: EnvelopeSignaturePayload,
	signature: Buffer,
): boolean {
	try {
		return verify(null, buildEnvelopeSignaturePayload(payload), senderPublicKeyEd25519, signature)
	} catch {
		return false
	}
}

/** Who verifies what, and why the server proves nothing. */

export type AgentMailboxTrustLevel = 'data' | 'instruction'

/**
 * One entry of THIS DEVICE's own local, ratified allowlist trace: it is
 * this local trace, never a server-reported column, that is authoritative
 * at read time. `isRatifiedLocally` must be sourced from
 * `trust/allowlist-store.ts`'s local file, never from any server-reported
 * ratification data: a caller that wires this field to server data
 * defeats the entire point of local ratification. See
 * `trust/resolve-trust.ts`, the one call site in this package allowed to
 * build this list.
 */
export interface AllowlistCandidate {
	publicKeyEd25519: Buffer
	trustLevel: AgentMailboxTrustLevel
	isRatifiedLocally: boolean
}

export type TrustResolution =
	{ matched: true; trustLevel: AgentMailboxTrustLevel; matchedPublicKeyEd25519: Buffer } | { matched: false }

/**
 * The central rule this file enforces, restated because it overrides
 * anything said elsewhere: the trust level derives from the key that
 * signed, never from a field the server transmits. This function never
 * accepts a server-asserted sender identity or trust level as input, only
 * the raw signature and this device's own candidate list. It tries every
 * candidate's public key against the signature and returns the trust level
 * of whichever one verifies, downgraded to `data` when that candidate is
 * not locally ratified; no candidate verifies, the caller must reject the
 * message (`{ matched: false }`) -- see `resolve-trust.ts`.
 */
function resolveTrustFromSignedBytes(
	candidates: ReadonlyArray<AllowlistCandidate>,
	signedBytes: Buffer,
	signature: Buffer,
): TrustResolution {
	for (const candidate of candidates) {
		const publicKey = importOkpPublicKeyFromRaw('Ed25519', candidate.publicKeyEd25519)
		try {
			if (verify(null, signedBytes, publicKey, signature)) {
				return {
					matched: true,
					trustLevel: candidate.isRatifiedLocally ? candidate.trustLevel : 'data',
					matchedPublicKeyEd25519: candidate.publicKeyEd25519,
				}
			}
		} catch {
			// Malformed signature against this candidate: try the next one.
		}
	}
	return { matched: false }
}

export function resolveTrustFromSignature(
	candidates: ReadonlyArray<AllowlistCandidate>,
	payload: EnvelopeSignaturePayload,
	signature: Buffer,
): TrustResolution {
	return resolveTrustFromSignedBytes(candidates, buildEnvelopeSignaturePayload(payload), signature)
}

/** See `EnvelopeSignaturePayloadDigests`'s doc comment: used by `resolve-trust.ts` for `inbox`/`search`. */
export function resolveTrustFromSignatureDigests(
	candidates: ReadonlyArray<AllowlistCandidate>,
	payload: EnvelopeSignaturePayloadDigests,
	signature: Buffer,
): TrustResolution {
	return resolveTrustFromSignedBytes(candidates, buildEnvelopeSignaturePayloadFromDigests(payload), signature)
}

/** Exposed for trust/ratify.ts, which needs to display a key fingerprint the human can compare. */
export function fingerprintPublicKey(rawPublicKey: Buffer): string {
	return createHash('sha256').update(rawPublicKey).digest('hex')
}
