import { randomBytes } from 'node:crypto'
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
	buildEnvelopeSignaturePayload,
	buildEnvelopeSignaturePayloadFromDigests,
	computeMailboxAddress,
	decryptBlock,
	deriveMailboxKeys,
	encodeKeyMaterial,
	encryptBlock,
	fingerprintPublicKey,
	openSealedKey,
	resolveTrustFromSignature,
	resolveTrustFromSignatureDigests,
	sealContentKey,
	signEnvelope,
	verifyEnvelopeSignature,
} from '../src/crypto/envelope-crypto.js'

function payloadFor(headerCiphertext: Buffer, bodyCiphertext: Buffer) {
	return {
		recipientAddress: 'aisc_recipient',
		messageUid: 'msg-1',
		headerCiphertext,
		bodyCiphertext,
		requestedExpiresAt: '2026-08-29T00:00:00.000Z',
		freshnessTimestamp: '2026-08-29T00:00:00.000Z',
	}
}

describe('deriveMailboxKeys', () => {
	it('is deterministic for the same seed', () => {
		const seed = randomBytes(32)
		const a = deriveMailboxKeys(seed)
		const b = deriveMailboxKeys(seed)
		expect(a.x25519.publicKeyRaw.equals(b.x25519.publicKeyRaw)).toBe(true)
		expect(a.ed25519.publicKeyRaw.equals(b.ed25519.publicKeyRaw)).toBe(true)
	})

	it('produces different keys for different seeds', () => {
		const a = deriveMailboxKeys(randomBytes(32))
		const b = deriveMailboxKeys(randomBytes(32))
		expect(a.x25519.publicKeyRaw.equals(b.x25519.publicKeyRaw)).toBe(false)
		expect(a.ed25519.publicKeyRaw.equals(b.ed25519.publicKeyRaw)).toBe(false)
	})

	it('derives two distinct keys from the same seed under distinct HKDF labels', () => {
		const keys = deriveMailboxKeys(randomBytes(32))
		expect(keys.x25519.publicKeyRaw.equals(keys.ed25519.publicKeyRaw)).toBe(false)
	})

	it('rejects a seed of the wrong length', () => {
		expect(() => deriveMailboxKeys(randomBytes(16))).toThrow()
	})
})

describe('encryptBlock / decryptBlock', () => {
	it('round-trips plaintext', () => {
		const key = randomBytes(32)
		const { ciphertext, iv } = encryptBlock(key, Buffer.from('hello world'))
		expect(decryptBlock(key, ciphertext, iv).toString('utf8')).toBe('hello world')
	})

	it('rejects decryption with a different key', () => {
		const { ciphertext, iv } = encryptBlock(randomBytes(32), Buffer.from('secret'))
		expect(() => decryptBlock(randomBytes(32), ciphertext, iv)).toThrow()
	})

	it('rejects a ciphertext altered by a single byte', () => {
		const key = randomBytes(32)
		const { ciphertext, iv } = encryptBlock(key, Buffer.from('secret'))
		const tampered = Buffer.from(ciphertext)
		const lastByte = tampered.at(-1)
		if (lastByte === undefined) throw new Error('unreachable: encryptBlock never returns an empty ciphertext')
		tampered.set([lastByte ^ 0x01], tampered.length - 1)
		expect(() => decryptBlock(key, tampered, iv)).toThrow()
	})
})

describe('sealContentKey / openSealedKey', () => {
	it('round-trips a content key for the intended recipient', () => {
		const recipient = deriveMailboxKeys(randomBytes(32))
		const contentKey = randomBytes(32)
		const { sealedKey, ephemeralPublicKey } = sealContentKey(recipient.x25519.publicKeyRaw, contentKey)
		const opened = openSealedKey(recipient.x25519.privateKey, ephemeralPublicKey, sealedKey)
		expect(opened.equals(contentKey)).toBe(true)
	})

	it('fails to open with a different recipient private key', () => {
		const recipient = deriveMailboxKeys(randomBytes(32))
		const attacker = deriveMailboxKeys(randomBytes(32))
		const { sealedKey, ephemeralPublicKey } = sealContentKey(recipient.x25519.publicKeyRaw, randomBytes(32))
		expect(() => openSealedKey(attacker.x25519.privateKey, ephemeralPublicKey, sealedKey)).toThrow()
	})
})

describe('signEnvelope / verifyEnvelopeSignature', () => {
	it('verifies a signature from the signing key', () => {
		const sender = deriveMailboxKeys(randomBytes(32))
		const payload = payloadFor(Buffer.from('header'), Buffer.from('body'))
		const signature = signEnvelope(sender.ed25519.privateKey, payload)
		expect(verifyEnvelopeSignature(sender.ed25519.publicKey, payload, signature)).toBe(true)
	})

	it('rejects a signature verified against a different public key', () => {
		const sender = deriveMailboxKeys(randomBytes(32))
		const other = deriveMailboxKeys(randomBytes(32))
		const payload = payloadFor(Buffer.from('header'), Buffer.from('body'))
		const signature = signEnvelope(sender.ed25519.privateKey, payload)
		expect(verifyEnvelopeSignature(other.ed25519.publicKey, payload, signature)).toBe(false)
	})

	it('rejects a signature over a tampered payload', () => {
		const sender = deriveMailboxKeys(randomBytes(32))
		const payload = payloadFor(Buffer.from('header'), Buffer.from('body'))
		const signature = signEnvelope(sender.ed25519.privateKey, payload)
		const tampered = { ...payload, recipientAddress: 'aisc_someone_else' }
		expect(verifyEnvelopeSignature(sender.ed25519.publicKey, tampered, signature)).toBe(false)
	})
})

describe('buildEnvelopeSignaturePayloadFromDigests', () => {
	it('produces byte-identical output to buildEnvelopeSignaturePayload given the hash of the same ciphertext', () => {
		const headerCiphertext = Buffer.from('header-bytes')
		const bodyCiphertext = Buffer.from('body-bytes')
		const full = buildEnvelopeSignaturePayload(payloadFor(headerCiphertext, bodyCiphertext))
		const fromDigests = buildEnvelopeSignaturePayloadFromDigests({
			recipientAddress: 'aisc_recipient',
			messageUid: 'msg-1',
			headerCiphertextSha256: createHash('sha256').update(headerCiphertext).digest(),
			bodyCiphertextSha256: createHash('sha256').update(bodyCiphertext).digest(),
			requestedExpiresAt: '2026-08-29T00:00:00.000Z',
			freshnessTimestamp: '2026-08-29T00:00:00.000Z',
		})
		expect(full.equals(fromDigests)).toBe(true)
	})
})

describe('resolveTrustFromSignature, the trust-from-signature invariant', () => {
	it('rejects when no candidate key verifies the signature', () => {
		const sender = deriveMailboxKeys(randomBytes(32))
		const unrelated = deriveMailboxKeys(randomBytes(32))
		const payload = payloadFor(Buffer.from('header'), Buffer.from('body'))
		const signature = signEnvelope(sender.ed25519.privateKey, payload)

		const resolution = resolveTrustFromSignature(
			[{ publicKeyEd25519: unrelated.ed25519.publicKeyRaw, trustLevel: 'instruction', isRatifiedLocally: true }],
			payload,
			signature,
		)
		expect(resolution.matched).toBe(false)
	})

	it('downgrades an unratified candidate to data even when configured as instruction', () => {
		const sender = deriveMailboxKeys(randomBytes(32))
		const payload = payloadFor(Buffer.from('header'), Buffer.from('body'))
		const signature = signEnvelope(sender.ed25519.privateKey, payload)

		const resolution = resolveTrustFromSignature(
			[{ publicKeyEd25519: sender.ed25519.publicKeyRaw, trustLevel: 'instruction', isRatifiedLocally: false }],
			payload,
			signature,
		)
		expect(resolution).toEqual({
			matched: true,
			trustLevel: 'data',
			matchedPublicKeyEd25519: sender.ed25519.publicKeyRaw,
		})
	})

	it('grants the ratified candidate its configured trust level, ignoring a wrong-key decoy candidate placed first (never trusts a server-asserted match by position)', () => {
		const sender = deriveMailboxKeys(randomBytes(32))
		const decoy = deriveMailboxKeys(randomBytes(32))
		const payload = payloadFor(Buffer.from('header'), Buffer.from('body'))
		const signature = signEnvelope(sender.ed25519.privateKey, payload)

		const resolution = resolveTrustFromSignature(
			[
				{ publicKeyEd25519: decoy.ed25519.publicKeyRaw, trustLevel: 'instruction', isRatifiedLocally: true },
				{ publicKeyEd25519: sender.ed25519.publicKeyRaw, trustLevel: 'data', isRatifiedLocally: true },
			],
			payload,
			signature,
		)
		expect(resolution).toEqual({
			matched: true,
			trustLevel: 'data',
			matchedPublicKeyEd25519: sender.ed25519.publicKeyRaw,
		})
	})
})

describe('resolveTrustFromSignatureDigests matches resolveTrustFromSignature', () => {
	it('resolves the same way from a digest-only payload as from the full buffers', () => {
		const sender = deriveMailboxKeys(randomBytes(32))
		const headerCiphertext = Buffer.from('header-bytes')
		const bodyCiphertext = Buffer.from('body-bytes')
		const payload = payloadFor(headerCiphertext, bodyCiphertext)
		const signature = signEnvelope(sender.ed25519.privateKey, payload)

		const candidates = [
			{
				publicKeyEd25519: sender.ed25519.publicKeyRaw,
				trustLevel: 'instruction' as const,
				isRatifiedLocally: true,
			},
		]

		const fullResolution = resolveTrustFromSignature(candidates, payload, signature)
		const digestResolution = resolveTrustFromSignatureDigests(
			candidates,
			{
				recipientAddress: payload.recipientAddress,
				messageUid: payload.messageUid,
				headerCiphertextSha256: createHash('sha256').update(headerCiphertext).digest(),
				bodyCiphertextSha256: createHash('sha256').update(bodyCiphertext).digest(),
				requestedExpiresAt: payload.requestedExpiresAt,
				freshnessTimestamp: payload.freshnessTimestamp,
			},
			signature,
		)

		expect(digestResolution).toEqual(fullResolution)
	})
})

describe('computeMailboxAddress', () => {
	it('is deterministic for the same public key', () => {
		const key = encodeKeyMaterial(randomBytes(32))
		expect(computeMailboxAddress(key)).toBe(computeMailboxAddress(key))
	})

	it('differs for different public keys', () => {
		expect(computeMailboxAddress(encodeKeyMaterial(randomBytes(32)))).not.toBe(
			computeMailboxAddress(encodeKeyMaterial(randomBytes(32))),
		)
	})

	it('is prefixed', () => {
		expect(computeMailboxAddress(encodeKeyMaterial(randomBytes(32)))).toMatch(/^aisc_/)
	})
})

describe('fingerprintPublicKey', () => {
	it('is deterministic', () => {
		const key = randomBytes(32)
		expect(fingerprintPublicKey(key)).toBe(fingerprintPublicKey(key))
	})
})
