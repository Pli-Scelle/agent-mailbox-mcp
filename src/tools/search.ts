/**
 * `search` filters pending message titles locally, on decrypted content.
 * No server endpoint of its own: this tool pages through the exact same
 * message listing `inbox` uses (api/mailbox-client.ts's `fetchMessagePage`),
 * decrypts and verifies each header exactly the way `inbox` does (trust/
 * resolve-trust.ts), then filters on the decrypted title client-side. The
 * server never sees the search query, and never sees which titles matched:
 * message bodies are never downloaded for a search, and that same
 * device-only guarantee extends here to the query itself, which also never
 * leaves the device.
 *
 * `maxPagesScanned` bounds how much of a large mailbox one call walks
 * before giving up and returning `nextCursor` for the caller to continue
 * from -- a mailbox with a high enough quota can hold far more pending
 * messages than a single tool call should decrypt in one pass.
 *
 * Titles are sender-controlled text visible here without a `read` call
 * (the mandatory-confirmation gate is scoped to `read` alone): the policy
 * sandwich (policy/injection-policy.ts) around the whole result, not
 * per-title, is this listing's mitigation for that gap, same reasoning as
 * `tools/inbox.ts`. Also touches this conversation's elicitation record the
 * same way `inbox` does -- see `touchConversationAfterAllowedAction`'s doc
 * comment.
 *
 * `title` is deliberately ABSENT from `structuredContent`/`outputSchema`,
 * for the exact reason `tools/inbox.ts`'s doc comment gives: a host reading
 * `structuredContent` directly must never receive sender-controlled text
 * unwrapped. `title` still reaches the agent, only inside the sandwiched
 * JSON blob in `content[0].text`.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { fetchMessagePage } from '../api/mailbox-client.js'
import { resolveConversationId } from '../elicitation/conversation-id.js'
import { touchConversationAfterAllowedAction } from '../elicitation/elicitation-store.js'
import { stripSenderControlledTitles, wrapUntrustedContent } from '../policy/injection-policy.js'
import { logAgentMailboxEvent } from '../server/logging.js'
import { MessageRejectedError, openMessageHeader } from '../trust/resolve-trust.js'
import { appendPendingCount } from './pending-count.js'

const MAX_PAGES_SCANNED_PER_CALL = 10
const PAGE_SIZE = 50

/** The safe, structured shape: never a sender-controlled text field. See the module doc comment. */
const searchItemSchema = z.object({
	id: z.string(),
	senderAddress: z.string(),
	senderLabel: z.string(),
	trustLevel: z.enum(['data', 'instruction']),
	isRatified: z.boolean(),
	sensitive: z.boolean(),
	bodyByteLength: z.number(),
	sentAt: z.string(),
})

/** Same as `searchItemSchema` plus the sender-controlled `title`, used ONLY to build the sandwiched `content[0].text` JSON blob, never `structuredContent`. */
interface SearchItemWithTitle extends z.infer<typeof searchItemSchema> {
	title: string
}

const searchOutputShape = {
	items: z.array(searchItemSchema),
	nextCursor: z.string().nullable(),
	scanExhausted: z.boolean(),
	pendingMessageCount: z.number(),
}

export function registerSearchTool(server: McpServer): void {
	server.registerTool(
		'search',
		{
			title: 'AIScelle search',
			description:
				'Searches pending AIScelle message titles locally on this device (the server never sees the query or which titles match). Case-insensitive substring match.',
			inputSchema: {
				query: z.string().min(1).max(200),
				cursor: z.string().optional().describe('Continue a previous search that hit its scan limit.'),
			},
			outputSchema: searchOutputShape,
			annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
		},
		async ({ query, cursor }, extra) => {
			const conversationId = resolveConversationId(extra)
			if (conversationId) await touchConversationAfterAllowedAction(conversationId)

			const needle = query.toLowerCase()
			const items: Array<SearchItemWithTitle> = []
			let nextCursor: string | null = cursor ?? null
			let scanExhausted = false

			for (let page = 0; page < MAX_PAGES_SCANNED_PER_CALL; page += 1) {
				const result = await fetchMessagePage({ cursor: nextCursor ?? undefined, limit: PAGE_SIZE })

				for (const message of result.items) {
					try {
						const opened = await openMessageHeader(message)
						if (opened.header.title.toLowerCase().includes(needle)) {
							items.push({
								id: message.id,
								title: opened.header.title,
								senderAddress: opened.senderAddress,
								senderLabel: opened.senderLabel,
								trustLevel: opened.trustLevel,
								isRatified: opened.isRatified,
								sensitive: opened.header.sensitive,
								bodyByteLength: opened.header.bodyByteLength,
								sentAt: opened.header.sentAt,
							})
						}
					} catch (error) {
						if (error instanceof MessageRejectedError) {
							logAgentMailboxEvent(server, { event: 'message_rejected', messageId: message.id })
							continue
						}
						throw error
					}
				}

				nextCursor = result.nextCursor
				if (!nextCursor) {
					scanExhausted = true
					break
				}
			}

			const withTitles = await appendPendingCount({ items, nextCursor, scanExhausted })
			// Strip the sender-controlled `title` before this reaches
			// `structuredContent`: see the module doc comment.
			const structuredContent = stripSenderControlledTitles(withTitles)

			return {
				content: [
					{
						type: 'text',
						text: await wrapUntrustedContent(
							JSON.stringify(withTitles),
							'AIScelle search results, message headers from various senders',
						),
					},
				],
				structuredContent: structuredContent as unknown as Record<string, unknown>,
			}
		},
	)
}
