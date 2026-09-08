/**
 * The one place this package decrypts a message and decides what to trust
 * it as: it takes the signature, tries to verify it against each public
 * key in the device's locally ratified allowlist, and keeps whichever
 * entry verifies. The trust level applied is that entry's own. If no key
 * verifies, the message is rejected. Every one of `tools/inbox.ts`,
 * `tools/search.ts`, `tools/read.ts` and `resources/
 * sensitive-message-resource.ts` opens a message through this module,
 * never by calling `crypto/envelope-crypto.ts` directly: this is the one
 * call site allowed to build an `AllowlistCandidate` list (from `trust/
 * allowlist-store.ts`'s LOCAL file, never from anything the server sent
 * about trust), so it is also the one place a future reviewer needs to
 * check to audit this trust invariant end to end.
 */
import { createHash } from 'node:crypto'
import type { MessageDetailResponse, MessageHeaderEntry } from '../api/wire-types.js'
import {
	type AllowlistCandidate,
	decodeKeyMaterial,
	decryptBlock,
	openSealedKey,
	resolveTrustFromSignature,
	resolveTrustFromSignatureDigests,
} from '../crypto/envelope-crypto.js'
import { loadMailboxIdentity } from '../crypto/mailbox-identity.js'
import { type HeaderPlaintext, decodeBodyPlaintext, decodeHeaderPlaintext } from '../crypto/message-plaintext.js'
import { readAllowlist } from './allowlist-store.js'

export class MessageRejectedError extends Error {
	constructor(messageId: string) {
		super(
			`AIScelle message ${messageId} was rejected: no locally known sender key verifies its signature. Either the server is lying about this message's origin, or the sender's key was never authorized on this device. This message is NOT shown to the agent.`,
		)
		this.name = 'MessageRejectedError'
	}
}

function hashBase64(base64: string): Buffer {
	return createHash('sha256').update(decodeKeyMaterial(base64)).digest()
}

/**
 * `resolveTrustFromSignature*`'s candidate list, alongside the allowlist
 * entries it was derived from: opening one message needs both, the
 * candidates to match the signature and the entries to name the sender the
 * matched key belongs to. They are read together so that a single message
 * costs a single read of the allowlist file rather than two of the same
 * file yielding the same bytes.
 *
 * Read fresh on every call and never cached ACROSS calls: this is a local
 * file a human can change (via `pliscelle-mcp ratify`) between two tool
 * invocations in the same running MCP process, and a stale in-memory copy
 * would silently keep trusting a correspondent this device just
 * ratified-away or that `trust/reconcile.ts` just purged. That is also why
 * the entries are not hoisted out and passed down across the messages of
 * one listing page: the freshness guarantee is per message, deliberately,
 * and holding one snapshot for a whole page would weaken it.
 */
async function loadTrustState(): Promise<{
	entries: Awaited<ReturnType<typeof readAllowlist>>
	candidates: Array<AllowlistCandidate>
}> {
	const entries = await readAllowlist()
	return {
		entries,
		candidates: entries.map((entry) => ({
			publicKeyEd25519: decodeKeyMaterial(entry.publicKeyEd25519),
			trustLevel: entry.trustLevel,
			isRatifiedLocally: entry.ratifiedLocally,
		})),
	}
}

export interface OpenedMessageHeader {
	trustLevel: 'data' | 'instruction'
	isRatified: boolean
	/** The locally-known sender this message's signature resolved to: derived from the matched key, never from `senderId`/`senderLabelSnapshot` reported by the server. */
	senderAddress: string
	senderLabel: string
	header: HeaderPlaintext
}

/**
 * `tools/inbox.ts` and `tools/search.ts`'s pipeline for one message: verify
 * against the header-only digest payload (crypto/envelope-crypto.ts's
 * `EnvelopeSignaturePayloadDigests`), reject if nothing verifies, decrypt
 * the header block if something did. Never touches the body: `inbox`/
 * `search` are read-only-of-headers by design, and this function has no
 * body ciphertext to decrypt from a `MessageHeaderEntry` in the first
 * place.
 */
export async function openMessageHeader(message: MessageHeaderEntry): Promise<OpenedMessageHeader> {
	const identity = await loadMailboxIdentity()
	const { entries, candidates } = await loadTrustState()

	const resolution = resolveTrustFromSignatureDigests(
		candidates,
		{
			recipientAddress: identity.address,
			messageUid: message.messageUid,
			headerCiphertextSha256: hashBase64(message.headerCiphertext),
			bodyCiphertextSha256: decodeKeyMaterial(message.bodyCiphertextSha256),
			requestedExpiresAt: message.requestedExpiresAt,
			freshnessTimestamp: message.freshnessTimestamp,
		},
		decodeKeyMaterial(message.signature),
	)
	if (!resolution.matched) throw new MessageRejectedError(message.id)

	const contentKey = openSealedKey(
		identity.keys.x25519.privateKey,
		decodeKeyMaterial(message.ephemeralPublicKey),
		decodeKeyMaterial(message.sealedKey),
	)
	const headerPlaintext = decryptBlock(
		contentKey,
		decodeKeyMaterial(message.headerCiphertext),
		decodeKeyMaterial(message.headerIv),
	)

	const matched = entries.find((entry) =>
		decodeKeyMaterial(entry.publicKeyEd25519).equals(resolution.matchedPublicKeyEd25519),
	)

	return {
		trustLevel: resolution.trustLevel,
		isRatified: matched?.ratifiedLocally ?? false,
		senderAddress: matched?.address ?? 'unknown',
		senderLabel: matched?.label ?? 'unknown',
		header: decodeHeaderPlaintext(headerPlaintext),
	}
}

export interface OpenedMessage extends OpenedMessageHeader {
	bodyText: string
}

/**
 * `tools/read.ts`'s pipeline: verify against the FULL buffer payload
 * (crypto/envelope-crypto.ts's `EnvelopeSignaturePayload`, matching the
 * server-side verification exactly, since a full body is available here),
 * reject if nothing verifies, decrypt both blocks. This device verifies
 * the signature against its ratified allowlist before returning anything
 * to the agent, and rejects the message if nothing verifies -- this
 * function never returns a partially-verified message; it either returns
 * the fully opened one or throws.
 */
export async function openMessage(message: MessageDetailResponse): Promise<OpenedMessage> {
	const identity = await loadMailboxIdentity()
	const { entries, candidates } = await loadTrustState()

	const resolution = resolveTrustFromSignature(
		candidates,
		{
			recipientAddress: identity.address,
			messageUid: message.messageUid,
			headerCiphertext: decodeKeyMaterial(message.headerCiphertext),
			bodyCiphertext: decodeKeyMaterial(message.bodyCiphertext),
			requestedExpiresAt: message.requestedExpiresAt,
			freshnessTimestamp: message.freshnessTimestamp,
		},
		decodeKeyMaterial(message.signature),
	)
	if (!resolution.matched) throw new MessageRejectedError(message.id)

	const contentKey = openSealedKey(
		identity.keys.x25519.privateKey,
		decodeKeyMaterial(message.ephemeralPublicKey),
		decodeKeyMaterial(message.sealedKey),
	)
	const headerPlaintext = decryptBlock(
		contentKey,
		decodeKeyMaterial(message.headerCiphertext),
		decodeKeyMaterial(message.headerIv),
	)
	const bodyPlaintext = decryptBlock(
		contentKey,
		decodeKeyMaterial(message.bodyCiphertext),
		decodeKeyMaterial(message.bodyIv),
	)

	const matched = entries.find((entry) =>
		decodeKeyMaterial(entry.publicKeyEd25519).equals(resolution.matchedPublicKeyEd25519),
	)

	const header = decodeHeaderPlaintext(headerPlaintext)

	return {
		trustLevel: resolution.trustLevel,
		isRatified: matched?.ratifiedLocally ?? false,
		senderAddress: matched?.address ?? 'unknown',
		senderLabel: matched?.label ?? 'unknown',
		header,
		bodyText: decodeBodyPlaintext(bodyPlaintext).text,
	}
}
