/**
 * `send` deposits a message. Not read-only, not idempotent, open-world
 * (this tool's own annotations declare `readOnlyHint: false`,
 * `idempotentHint: false`, `openWorldHint: true`). This tool signs and
 * encrypts entirely on this device (crypto/envelope-crypto.ts): the server
 * never sees plaintext, a title, or a sensitivity flag it could act on --
 * only opaque ciphertext blocks. That promise holds only because the
 * recipient key this tool seals for is checked against the address it
 * claims to belong to before any of it happens; the check sits at the
 * lookup below and carries its own reasoning.
 *
 * The mandatory confirmation after a `read` in the same conversation is
 * enforced here, first, before any crypto or network work:
 * `elicitation/elicitation-gate.ts` is the single call site that decides
 * whether this call may proceed, and its own doc comment is the authority
 * on what "a read happened" actually means for this device.
 * `commitAllowedAction` runs only after `depositMessage` below has actually
 * succeeded, never before -- see that function's own doc comment for why.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { depositMessage, lookupRecipientPublicKey } from '../api/mailbox-client.js'
import {
	computeMailboxAddress,
	decodeKeyMaterial,
	encodeKeyMaterial,
	encryptBlock,
	generateContentKey,
	sealContentKey,
	signEnvelope,
} from '../crypto/envelope-crypto.js'
import { loadMailboxIdentity } from '../crypto/mailbox-identity.js'
import { encodeBodyPlaintext, encodeHeaderPlaintext } from '../crypto/message-plaintext.js'
import { commitAllowedAction, evaluateElicitationGate } from '../elicitation/elicitation-gate.js'
import { elicitationRefusalMessage } from './elicitation-refusal.js'
import { appendPendingCount } from './pending-count.js'

/** The plaintext body is capped at 50,000 characters before encryption. */
const MAX_BODY_PLAINTEXT_CHARS = 50_000
/** Signature freshness window. Must be well inside the server's own 15-minute acceptance window for the signed timestamp. */
const FRESHNESS_SAFETY_MARGIN_MINUTES = 1

const sendOutputShape = {
	messageId: z.string(),
	pendingMessageCount: z.number(),
	pendingRatificationCount: z.number(),
}

export function registerSendTool(server: McpServer): void {
	server.registerTool(
		'send',
		{
			title: 'AIScelle send',
			description:
				'Sends an end-to-end encrypted AIScelle message to a recipient address. The server never sees the title or body.',
			inputSchema: {
				recipientAddress: z.string().min(1),
				title: z.string().min(1).max(200),
				body: z.string().min(1).max(MAX_BODY_PLAINTEXT_CHARS),
				sensitive: z.boolean().optional().default(false),
				maxReads: z.number().int().min(1).optional(),
			},
			outputSchema: sendOutputShape,
			annotations: { readOnlyHint: false, idempotentHint: false, openWorldHint: true },
		},
		async ({ recipientAddress, title, body, sensitive, maxReads }, extra) => {
			const gate = await evaluateElicitationGate(server, extra, {
				tool: 'send',
				confirmationMessage: `This conversation has read an AIScelle message. Confirm sending a new AIScelle message to ${recipientAddress}?`,
			})
			if (!gate.allowed) {
				return {
					isError: true,
					content: [{ type: 'text' as const, text: elicitationRefusalMessage('send', gate.reason) }],
				}
			}

			const identity = await loadMailboxIdentity()
			const { publicKeyX25519 } = await lookupRecipientPublicKey(recipientAddress)

			// An address IS the SHA-256 fingerprint of the very X25519 key
			// this lookup returns (4.1), so the answer is verifiable right
			// here against the address the caller asked for: no allowlist, no
			// ratification, no second round trip. Checking it is what keeps
			// this tool's stated promise that the server never sees a title or
			// a body. Without the check, a compromised server answers the
			// lookup with a key of its own, opens the sealed content key,
			// reads both blocks, then re-seals that same content key for the
			// real recipient. The signature does not catch the substitution:
			// `buildSignedFields` covers the two ciphertexts and neither
			// `sealedKey` nor `ephemeralPublicKey`, so the re-sealed message
			// still verifies on arrival and neither end sees anything. Note
			// this is a different question from ratification, which binds the
			// Ed25519 signing key of an INCOMING sender and, by design (12.3),
			// says nothing about the encryption key of an outgoing recipient.
			if (computeMailboxAddress(publicKeyX25519) !== recipientAddress) {
				return {
					isError: true,
					content: [
						{
							type: 'text' as const,
							text: `Refusing to send: the public key returned for ${recipientAddress} does not hash to that address. An address is the fingerprint of the key it names, so this mismatch means the key returned is not the one that address stands for. Nothing was encrypted, nothing was sent.`,
						},
					],
				}
			}

			const contentKey = generateContentKey()
			const now = new Date()

			const header = encryptBlock(
				contentKey,
				encodeHeaderPlaintext({
					title,
					sensitive: sensitive ?? false,
					bodyByteLength: Buffer.byteLength(body, 'utf8'),
					sentAt: now.toISOString(),
				}),
			)
			const bodyBlock = encryptBlock(contentKey, encodeBodyPlaintext({ text: body }))
			const { sealedKey, ephemeralPublicKey } = sealContentKey(decodeKeyMaterial(publicKeyX25519), contentKey)

			const messageUid = randomUUID()
			const requestedExpiresAt = new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString()
			const freshnessTimestamp = new Date(
				now.getTime() + FRESHNESS_SAFETY_MARGIN_MINUTES * 60 * 1000,
			).toISOString()

			const signature = signEnvelope(identity.keys.ed25519.privateKey, {
				recipientAddress,
				messageUid,
				headerCiphertext: header.ciphertext,
				bodyCiphertext: bodyBlock.ciphertext,
				requestedExpiresAt,
				freshnessTimestamp,
			})

			const response = await depositMessage({
				recipientAddress,
				senderPublicKeyEd25519: identity.publicKeyEd25519Base64,
				messageUid,
				headerCiphertext: encodeKeyMaterial(header.ciphertext),
				headerIv: encodeKeyMaterial(header.iv),
				bodyCiphertext: encodeKeyMaterial(bodyBlock.ciphertext),
				bodyIv: encodeKeyMaterial(bodyBlock.iv),
				sealedKey: encodeKeyMaterial(sealedKey),
				ephemeralPublicKey: encodeKeyMaterial(ephemeralPublicKey),
				signature: encodeKeyMaterial(signature),
				byteSize: header.ciphertext.length + bodyBlock.ciphertext.length,
				requestedExpiresAt,
				freshnessTimestamp,
				maxReads,
			})

			await commitAllowedAction(gate.conversationId)

			const structuredContent = await appendPendingCount({ messageId: response.id })
			return {
				content: [{ type: 'text' as const, text: `Message sent to ${recipientAddress}.` }],
				structuredContent: structuredContent as unknown as Record<string, unknown>,
			}
		},
	)
}
