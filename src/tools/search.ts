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
 * from: a mailbox with a high enough quota can hold far more pending
 * messages than a single tool call should decrypt in one pass.
 *
 * Titles are sender-controlled text visible here without a `read` call
 * (the mandatory-confirmation gate is scoped to `read` alone): the policy
 * sandwich (policy/injection-policy.ts) around the whole result, not
 * per-title, is this listing's mitigation for that gap, same reasoning as
 * `tools/inbox.ts`. Also touches this conversation's elicitation record the
 * same way `inbox` does: see `touchConversationAfterAllowedAction`'s doc
 * comment.
 *
 * Same two channels as `tools/inbox.ts`, for the reason its doc comment
 * gives: typed headers without `title` in `structuredContent`, and the
 * sandwiched block, titles included, both as the text of `content` and as
 * `wrappedContent`.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { fetchMessagePage } from '../api/mailbox-client.js'
import { resolveConversationId } from '../elicitation/conversation-id.js'
import { touchConversationAfterAllowedAction } from '../elicitation/elicitation-store.js'
import { renderWithDeviceHeader } from '../policy/injection-policy.js'
import { logAgentMailboxEvent } from '../server/logging.js'
import { MessageRejectedError, openMessageHeader } from '../trust/resolve-trust.js'
import { appendPendingCount } from './pending-count.js'

const MAX_PAGES_SCANNED_PER_CALL = 10
const PAGE_SIZE = 50

/** The typed shape of a matching item: never a sender-controlled text field. See the module doc comment. */
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

/** Same plus the sender-controlled `title`, used ONLY inside the sandwiched block. */
interface SearchItem extends z.infer<typeof searchItemSchema> {
	title: string
}

const searchOutputShape = {
	items: z.array(searchItemSchema),
	nextCursor: z.string().nullable(),
	scanExhausted: z.boolean(),
	pendingMessageCount: z.number(),
	pendingRatificationCount: z.number(),
	wrappedContent: z.string(),
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
			const items: Array<SearchItem> = []
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

			// In the text, the cursor is an opaque string the server chose: it
			// goes inside the block, never on the device header line.
			const deviceFields = await appendPendingCount({ scanExhausted })
			const wrappedContent = await renderWithDeviceHeader(
				deviceFields,
				JSON.stringify({ items, nextCursor }),
				'AIScelle search results, message headers from various senders',
			)

			return {
				content: [{ type: 'text', text: wrappedContent }],
				structuredContent: {
					items: items.map(({ title: _title, ...typed }) => typed),
					nextCursor,
					...deviceFields,
					wrappedContent,
				},
			}
		},
	)
}
