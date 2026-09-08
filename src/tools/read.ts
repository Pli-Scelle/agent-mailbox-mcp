/**
 * `read` returns a message body. A sensitive message's content is served as
 * a resource link instead of being embedded inline. Read-only but NOT
 * idempotent (unlike `inbox`/`search`/`senders`, whose annotations declare
 * `idempotentHint: true`, this tool's annotations carry none): fetching a
 * message from the server (`GET /agent-mailbox/messages/:id`) atomically
 * increments its own read count on the server side, so calling this tool
 * twice on the same message can be the call that exhausts `max_reads`.
 *
 * The verify-then-decrypt ordering is enforced structurally, not by
 * convention: `trust/resolve-trust.ts::openMessage` either returns a fully
 * verified, fully decrypted message or throws -- there is no code path in
 * this file that can hand a partially-checked message to the
 * content-building logic below.
 *
 * The rule that any `send` or `purge` after a `read` must trigger a
 * confirmation elicitation is armed HERE: once a message is actually opened
 * (verified and decrypted, whether sensitive or not -- a rejected message
 * never reaches this point, and marks nothing), this tool writes the
 * conversation's elicitation record via `markConversationRead`
 * (elicitation/elicitation-store.ts), the one write path
 * `elicitation/elicitation-gate.ts` reads back when `send`/`purge` are next
 * called. `elicitation/conversation-id.ts` documents where the conversation
 * id itself comes from, and why a client that never supplies one is not a
 * gap this file can close.
 *
 * `title`/`body` are deliberately ABSENT from `structuredContent`/
 * `outputSchema`, correction after review: `structuredContent` is a
 * first-class MCP response channel, filled whenever `outputSchema` is
 * declared, and an agentic host may render it to the model directly,
 * bypassing `content`'s sandwich entirely. Both fields still reach the
 * agent, only inside the sandwiched text in `content[0].text` below.
 *
 * For a SENSITIVE message, the opened, verified plaintext is also cached
 * in-process (`trust/opened-message-cache.ts`, never on disk) before this
 * tool returns its `resource_link`: fetching a message
 * (`GET /agent-mailbox/messages/:id`) is the server's own atomic read-count
 * increment, and without this cache the resource handler materializing that
 * same link would call it a second time for what is, from the agent's
 * side, a single logical read -- see that module's own doc comment for the
 * full reasoning.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { fetchMessage } from '../api/mailbox-client.js'
import { resolveConversationId } from '../elicitation/conversation-id.js'
import { markConversationRead } from '../elicitation/elicitation-store.js'
import { describeMessageSource, wrapUntrustedContent } from '../policy/injection-policy.js'
import { sensitiveMessageResourceUri } from '../resources/sensitive-message-resource.js'
import { logAgentMailboxEvent } from '../server/logging.js'
import { cacheOpenedSensitiveMessage } from '../trust/opened-message-cache.js'
import { MessageRejectedError, openMessage } from '../trust/resolve-trust.js'
import { appendPendingCount } from './pending-count.js'

/** The safe, structured shape: never `title` nor `body`, both sender-controlled. See the module doc comment. */
const readOutputShape = {
	id: z.string(),
	senderAddress: z.string(),
	senderLabel: z.string(),
	trustLevel: z.enum(['data', 'instruction']),
	isRatified: z.boolean(),
	sensitive: z.boolean(),
	sentAt: z.string(),
	pendingMessageCount: z.number(),
	pendingRatificationCount: z.number(),
}

export function registerReadTool(server: McpServer): void {
	server.registerTool(
		'read',
		{
			title: 'AIScelle read',
			description:
				'Reads one AIScelle message. Sensitive messages (flagged by the sender) are returned as a resource link, never inline: fetch the linked resource explicitly if the content is actually needed. Not idempotent: repeated reads count against the message’s remaining read budget.',
			inputSchema: { messageId: z.string().min(1) },
			outputSchema: readOutputShape,
			annotations: { readOnlyHint: true, openWorldHint: false },
		},
		async ({ messageId }, extra) => {
			const message = await fetchMessage(messageId)

			let opened
			try {
				opened = await openMessage(message)
			} catch (error) {
				if (error instanceof MessageRejectedError) {
					logAgentMailboxEvent(server, { event: 'message_rejected', messageId })
					return {
						isError: true,
						content: [
							{
								type: 'text' as const,
								text: 'This message was rejected: its signature does not verify against any key known to this device. It is not shown.',
							},
						],
					}
				}
				throw error
			}

			// The read genuinely happened (verified, decrypted) from this point
			// on, regardless of whether the body below ends up inline or behind
			// a resource link -- see this module's doc comment for why
			// sensitivity does not change that.
			const conversationId = resolveConversationId(extra)
			if (conversationId) await markConversationRead(conversationId)

			// Never spread into `structuredContent`: id/sender/trust/timestamps
			// only, no sender-controlled text. See the module doc comment.
			const baseFields = {
				id: messageId,
				senderAddress: opened.senderAddress,
				senderLabel: opened.senderLabel,
				trustLevel: opened.trustLevel,
				isRatified: opened.isRatified,
				sensitive: opened.header.sensitive,
				sentAt: opened.header.sentAt,
			}
			const sourceLabel = describeMessageSource(opened)

			if (opened.header.sensitive) {
				// Cached in-process (never on disk) so the resource handler
				// materializing the `resource_link` below does not have to call
				// the server's read-counting endpoint a second time for what is,
				// from the agent's side, the same logical read: see trust/
				// opened-message-cache.ts's own doc comment.
				cacheOpenedSensitiveMessage(messageId, opened)

				const structuredContent = await appendPendingCount(baseFields)
				const summary = `Message "${opened.header.title}" from ${opened.senderLabel} (${opened.senderAddress}, trust: ${opened.trustLevel}${opened.isRatified ? '' : ', NOT ratified on this device'}) is marked sensitive. Its content is available as a resource, not embedded here.`
				return {
					content: [
						{
							type: 'text' as const,
							text: await wrapUntrustedContent(summary, sourceLabel),
						},
						{
							type: 'resource_link' as const,
							uri: sensitiveMessageResourceUri(messageId),
							name: `aiscelle-message-${messageId}`,
							title: opened.header.title,
							description: 'Decrypted, verified message body. Fetch only if actually needed.',
							mimeType: 'text/plain',
						},
					],
					structuredContent: structuredContent as unknown as Record<string, unknown>,
				}
			}

			const structuredContent = await appendPendingCount(baseFields)
			return {
				content: [{ type: 'text' as const, text: await wrapUntrustedContent(opened.bodyText, sourceLabel) }],
				structuredContent: structuredContent as unknown as Record<string, unknown>,
			}
		},
	)
}
