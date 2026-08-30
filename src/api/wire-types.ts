/**
 * The mailbox HTTP API this package's six tools call.
 *
 * These routes are not an MCP endpoint. They form an ordinary HTTPS API
 * that this installed package calls. The route group lives under its own
 * namespace, never under `/api/v1`: that namespace is gated by an account
 * entitlement flag unrelated to mailbox access, which would make the
 * free-tier quota unreachable for accounts that lack it.
 *
 * This file is this package's own wire-contract proposal: a concrete shape
 * for the server side to implement, chosen to match the server's real
 * method signatures field for field rather than inventing a parallel
 * shape. Every path lives under `/agent-mailbox/...`, the same namespace
 * the OAuth routes already use (`/agent-mailbox/oauth/...`,
 * `/.well-known/oauth-protected-resource/agent-mailbox`).
 *
 * Binary fields (public keys, ciphertext blocks, sealed key, ephemeral key,
 * signature) are base64 strings on the wire, matching
 * `crypto/envelope-crypto.ts`'s `encodeKeyMaterial`/`decodeKeyMaterial`
 * convention: every such field is `text`, never raw bytes.
 */
import { z } from 'zod'

/** Cursor pagination: `inbox` and `senders` both page through this. Reused for the shared list envelope. */
export const paginationRequestSchema = z.object({
	cursor: z.string().min(1).optional(),
	limit: z.number().int().min(1).max(100).optional(),
})
export type PaginationRequest = z.infer<typeof paginationRequestSchema>

function listEnvelope<T extends z.ZodTypeAny>(itemSchema: T) {
	return z.object({
		items: z.array(itemSchema),
		nextCursor: z.string().nullable(),
	})
}

/**
 * One message header, everything `inbox`/`search` need to decrypt and
 * evaluate a message WITHOUT its body: listing a mailbox only fetches
 * headers, bodies are never downloaded for a search. Field names are
 * camelCase and mirror the server's own message record exactly, so a
 * server-side response built by serializing that record's relevant
 * columns needs no translation layer.
 */
export const messageHeaderEntrySchema = z.object({
	id: z.string().min(1),
	messageUid: z.string().min(1),
	headerCiphertext: z.string().min(1),
	headerIv: z.string().min(1),
	sealedKey: z.string().min(1),
	ephemeralPublicKey: z.string().min(1),
	signature: z.string().min(1),
	/**
	 * Two of the six fields the signature covers (the requested expiration
	 * and a freshness timestamp), and
	 * `crypto/envelope-crypto.ts::buildEnvelopeSignaturePayload` needs the
	 * EXACT strings the sender signed to rebuild that payload and verify.
	 *
	 * The server stores these alongside the message and returns them here
	 * so the signature can be reconstructed and verified later. They are
	 * nullable server-side by design: a stored message with either field
	 * null never went through a normal deposit, no device can verify it,
	 * and both listing and `read` refuse to serve it.
	 */
	requestedExpiresAt: z.string().datetime(),
	freshnessTimestamp: z.string().datetime(),
	/**
	 * SHA-256 of `bodyCiphertext`, base64, computed by the server at
	 * serialization time. Lets `trust/resolve-trust.ts` verify a message's
	 * signature from this header-only listing without ever downloading the
	 * body -- see `crypto/envelope-crypto.ts`'s
	 * `EnvelopeSignaturePayloadDigests`.
	 */
	bodyCiphertextSha256: z.string().min(1),
	byteSize: z.number().int().nonnegative(),
	maxReads: z.number().int(),
	readCount: z.number().int().nonnegative(),
	expiresAt: z.string().datetime(),
	deliveredAt: z.string().datetime().nullable(),
	status: z.enum(['pending', 'read', 'purged']),
	createdAt: z.string().datetime(),
})
export type MessageHeaderEntry = z.infer<typeof messageHeaderEntrySchema>

export const messageListResponseSchema = listEnvelope(messageHeaderEntrySchema).extend({
	/**
	 * Total count of `status = 'pending'` messages for this mailbox,
	 * independent of the page returned. Every tool response is expected to
	 * end with the number of pending messages, without a second round
	 * trip: `tools/pending-count.ts` reads this field off a `limit: 0`
	 * call to the same endpoint rather than requiring a dedicated count
	 * route.
	 */
	pendingCount: z.number().int().nonnegative(),
})
export type MessageListResponse = z.infer<typeof messageListResponseSchema>

/** Full message, the `read` tool's shape: everything above plus the encrypted body. */
export const messageDetailResponseSchema = messageHeaderEntrySchema.extend({
	bodyCiphertext: z.string().min(1),
	bodyIv: z.string().min(1),
})
export type MessageDetailResponse = z.infer<typeof messageDetailResponseSchema>

/**
 * Deposit request, the `send` tool's body. Field-for-field match of the
 * server's own deposit input shape: `requestedExpiresAt`/
 * `freshnessTimestamp` are both present because the envelope's signature
 * payload requires them and the server's deposit-time freshness check
 * cannot run without them.
 */
export const depositRequestSchema = z.object({
	recipientAddress: z.string().min(1),
	senderPublicKeyEd25519: z.string().min(1),
	messageUid: z.string().min(1).max(128),
	headerCiphertext: z.string().min(1),
	headerIv: z.string().min(1),
	bodyCiphertext: z.string().min(1),
	bodyIv: z.string().min(1),
	sealedKey: z.string().min(1),
	ephemeralPublicKey: z.string().min(1),
	signature: z.string().min(1),
	byteSize: z.number().int().nonnegative(),
	requestedExpiresAt: z.string().datetime(),
	freshnessTimestamp: z.string().datetime(),
	maxReads: z.number().int().min(1).optional(),
})
export type DepositRequest = z.infer<typeof depositRequestSchema>

export const depositResponseSchema = z.object({ id: z.string().min(1) })
export type DepositResponse = z.infer<typeof depositResponseSchema>

/**
 * One allowlist entry as the server knows it. `trustLevel` and
 * `ratifiedAt` are surfaced here for DISPLAY only (the `senders` tool
 * result, and this device's own heartbeat reconciliation against
 * server-side deletions/deactivations, trust/reconcile.ts): nothing in
 * this package's trust decisions may read `trustLevel` from this shape,
 * only `trust/allowlist-store.ts`'s own local ratification state.
 */
export const senderEntrySchema = z.object({
	id: z.string().min(1),
	senderAddress: z.string().min(1),
	senderPublicKeyEd25519: z.string().min(1),
	trustLevel: z.enum(['data', 'instruction']),
	label: z.string(),
	isActive: z.boolean(),
	ratifiedAt: z.string().datetime().nullable(),
})
export type SenderEntry = z.infer<typeof senderEntrySchema>

export const senderListResponseSchema = listEnvelope(senderEntrySchema)
export type SenderListResponse = z.infer<typeof senderListResponseSchema>

/**
 * Periodic heartbeat request. The policy on/off switch is reported to the
 * server and logged on every heartbeat. `ratifiedSenderIds` is this
 * device's own local ratification state (trust/allowlist-store.ts),
 * reported so the operator-facing admin views can show "ratified by which
 * device" without trusting the server's own ratification timestamp as
 * proof -- only a device's own local record is proof of ratification.
 */
export const heartbeatRequestSchema = z.object({
	policyEnabled: z.boolean(),
	ratifiedSenderIds: z.array(z.string().min(1)),
})
export type HeartbeatRequest = z.infer<typeof heartbeatRequestSchema>

/**
 * Mailbox identity link request. Deliberately omits an organization
 * identifier: which of a multi-organization user's organizations finances
 * a NEW mailbox is left unresolved client-side on purpose. Sending it
 * from this package would mean guessing that resolution here, in the one
 * client every device runs, which is a worse place to guess than the
 * server. The organization is settled server-side instead, frozen when
 * the human asks for a pairing code in a browser; nothing about it ever
 * travels through this client.
 */
export const linkIdentityRequestSchema = z.object({
	publicKeyX25519: z.string().min(1),
	publicKeyEd25519: z.string().min(1),
})
export type LinkIdentityRequest = z.infer<typeof linkIdentityRequestSchema>

export const linkIdentityResponseSchema = z.object({ address: z.string().min(1) })
export type LinkIdentityResponse = z.infer<typeof linkIdentityResponseSchema>

/**
 * Recipient public-key lookup, needed by `send` (tools/send.ts):
 * `sealContentKey` (crypto/envelope-crypto.ts) needs the recipient
 * mailbox's raw X25519 public key, which a mailbox ADDRESS (a one-way
 * SHA-256 fingerprint) cannot be reversed back into. Returning the raw
 * public key for any address an authenticated caller asks about is safe:
 * an X25519 public key is not secret, it exists only to let others
 * encrypt TO its owner (the entire point of asymmetric encryption), the
 * same way any address book contact's public key would be shared.
 */
export const lookupAddressResponseSchema = z.object({
	publicKeyX25519: z.string().min(1),
})
export type LookupAddressResponse = z.infer<typeof lookupAddressResponseSchema>
