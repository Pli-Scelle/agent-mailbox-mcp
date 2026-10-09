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
 * verified, fully decrypted message or throws: there is no code path in
 * this file that can hand a partially-checked message to the
 * content-building logic below.
 *
 * The rule that any `send` or `purge` after a `read` must trigger a
 * confirmation elicitation is armed HERE: once a message is actually opened
 * (verified and decrypted, whether sensitive or not; a rejected message
 * never reaches this point, and marks nothing), this tool writes the
 * conversation's elicitation record via `markConversationRead`
 * (elicitation/elicitation-store.ts), the one write path
 * `elicitation/elicitation-gate.ts` reads back when `send`/`purge` are next
 * called. `elicitation/conversation-id.ts` documents where the conversation
 * id itself comes from, and why a client that never supplies one is not a
 * gap this file can close.
 *
 * Title and body are sender-controlled and only ever travel inside the
 * sandwich, never as bare typed fields. The sandwiched block (what this
 * device verified first, then the title and body, policy/
 * injection-policy.ts's `renderWithDeviceHeader`) is returned twice: as the
 * text of `content`, and as `wrappedContent` in `structuredContent`. A host
 * that receives `structuredContent` may hand the model that JSON alone and
 * drop the text blocks of `content`: measured on Claude Code 2.1.287, where
 * the agent got the headers and never the body (issue #1403). The other
 * fields of `structuredContent` are the typed headers a client calling this
 * tool by code relies on; removing them breaks such a client.
 *
 * For a SENSITIVE message, the opened, verified plaintext is also cached
 * in-process (`trust/opened-message-cache.ts`, never on disk) before this
 * tool returns its `resource_link`: fetching a message
 * (`GET /agent-mailbox/messages/:id`) is the server's own atomic read-count
 * increment, and without this cache the resource handler materializing that
 * same link would call it a second time for what is, from the agent's
 * side, a single logical read: see that module's own doc comment for the
 * full reasoning.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { fetchMessage } from '../api/mailbox-client.js'
import { resolveConversationId } from '../elicitation/conversation-id.js'
import { markConversationRead } from '../elicitation/elicitation-store.js'
import { describeMessageSource, printableAddress, renderWithDeviceHeader } from '../policy/injection-policy.js'
import { sensitiveMessageResourceUri } from '../resources/sensitive-message-resource.js'
import { logAgentMailboxEvent } from '../server/logging.js'
import { cacheOpenedSensitiveMessage } from '../trust/opened-message-cache.js'
import { MessageRejectedError, openMessage } from '../trust/resolve-trust.js'
import { appendPendingCount } from './pending-count.js'

/** Typed headers, plus the sandwiched block. Never `title` nor `body` as fields of their own: see the module doc comment. */
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
	wrappedContent: z.string(),
}

export function registerReadTool(server: McpServer): void {
	server.registerTool(
		'read',
		{
			title: 'AIScelle read',
			description:
				'Reads one AIScelle message. Its title and body are in wrappedContent. Sensitive messages (flagged by the sender) are returned as a resource link, never inline: fetch the linked resource explicitly if the content is actually needed. Not idempotent: repeated reads count against the remaining read budget.',
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
			// a resource link: see this module's doc comment for why
			// sensitivity does not change that.
			const conversationId = resolveConversationId(extra)
			if (conversationId) await markConversationRead(conversationId)

			// Cached in-process (never on disk), and before anything below can
			// fail: the server already counted this read, and the resource
			// handler materializing the `resource_link` must not have to call
			// the counting endpoint a second time for what is, from the agent's
			// side, the same logical read. See trust/opened-message-cache.ts.
			if (opened.header.sensitive) cacheOpenedSensitiveMessage(messageId, opened)

			// What this device itself verified, printed outside the sandwich: no
			// sender-controlled text may ever join these fields. The label is
			// left out for that reason: the server relays it and may rewrite it
			// after ratification. It only appears in the block's source line.
			const deviceFields = await appendPendingCount({
				id: messageId,
				senderAddress: printableAddress(opened.senderAddress),
				trustLevel: opened.trustLevel,
				isRatified: opened.isRatified,
				sensitive: opened.header.sensitive,
				sentAt: opened.header.sentAt,
			})
			const sourceLabel = describeMessageSource(opened)
			// The typed headers a client reading by code relies on: no title,
			// no body.
			const typedFields = {
				...deviceFields,
				senderAddress: opened.senderAddress,
				senderLabel: opened.senderLabel,
			}

			if (opened.header.sensitive) {
				const summary = `Title: ${opened.header.title}\n\nThis message is marked sensitive. Its content is available as a resource, not embedded here.`
				const wrappedContent = await renderWithDeviceHeader(deviceFields, summary, sourceLabel)
				return {
					content: [
						{ type: 'text' as const, text: wrappedContent },
						// No `title` on the link: it is sender-controlled, and a link
						// field sits outside the sandwich.
						{
							type: 'resource_link' as const,
							uri: sensitiveMessageResourceUri(messageId),
							name: `aiscelle-message-${messageId}`,
							description: 'Decrypted, verified message body. Fetch only if actually needed.',
							mimeType: 'text/plain',
						},
					],
					structuredContent: { ...typedFields, wrappedContent },
				}
			}

			const titleAndBody = `Title: ${opened.header.title}\n\n${opened.bodyText}`
			const wrappedContent = await renderWithDeviceHeader(deviceFields, titleAndBody, sourceLabel)
			return {
				content: [{ type: 'text' as const, text: wrappedContent }],
				structuredContent: { ...typedFields, wrappedContent },
			}
		},
	)
}
