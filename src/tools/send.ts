/**
 * `send` deposits a message. Not read-only, not idempotent, open-world
 * (this tool's own annotations declare `readOnlyHint: false`,
 * `idempotentHint: false`, `openWorldHint: true`). This tool signs and
 * encrypts entirely on this device (crypto/envelope-crypto.ts): the server
 * never sees plaintext, a title, or a sensitivity flag it could act on --
 * only opaque ciphertext blocks.
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
