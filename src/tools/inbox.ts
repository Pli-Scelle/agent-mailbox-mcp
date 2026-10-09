/**
 * `inbox` lists pending message headers, paginated by cursor. Read-only,
 * idempotent. Every message returned here has already passed signature
 * verification (trust/resolve-trust.ts): a message whose signature verifies
 * against no locally ratified OR locally-known key is silently dropped from
 * this list, logged locally, never surfaced to the agent as a row with an
 * error in it: surfacing it as data would itself be a form of trusting
 * server-asserted content this device has not verified.
 *
 * Titles are sender-controlled text, visible here WITHOUT a `read` call:
 * the mandatory-confirmation gate is scoped to the `read` tool alone, so a
 * title-only injection never trips it. The policy sandwich
 * (policy/injection-policy.ts) is this listing's actual mitigation for that
 * gap and wraps the whole JSON blob once, not per title.
 *
 * Also touches this conversation's elicitation record (elicitation/
 * elicitation-store.ts), establishing (never downgrading) a clean baseline
 * so a `send`/`purge` later in the same conversation, if nothing was ever
 * read, is not needlessly gated: see `touchConversationAfterAllowedAction`'s
 * own doc comment for why this is safe.
 *
 * `title` never appears as a typed field of `structuredContent`: the items
 * there carry the verified headers only, the shape a client listing the
 * mailbox by code relies on. The titles travel inside the sandwiched block,
 * returned both as the text of `content` and as `wrappedContent` in
 * `structuredContent`, for the reason `tools/read.ts`'s doc comment gives
 * (issue #1403): a host handed `structuredContent` may drop the text of
 * `content`.
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

/** The typed shape of a listed item: never a sender-controlled text field. See the module doc comment. */
const inboxItemSchema = z.object({
	id: z.string(),
	senderAddress: z.string(),
	senderLabel: z.string(),
	trustLevel: z.enum(['data', 'instruction']),
	isRatified: z.boolean(),
	sensitive: z.boolean(),
	bodyByteLength: z.number(),
	sentAt: z.string(),
	expiresAt: z.string(),
})

/** Same plus the sender-controlled `title`, used ONLY inside the sandwiched block. */
interface InboxItem extends z.infer<typeof inboxItemSchema> {
	title: string
}

const inboxOutputShape = {
	items: z.array(inboxItemSchema),
	nextCursor: z.string().nullable(),
	pendingMessageCount: z.number(),
	pendingRatificationCount: z.number(),
	wrappedContent: z.string(),
}

export function registerInboxTool(server: McpServer): void {
	server.registerTool(
		'inbox',
		{
			title: 'AIScelle inbox',
			description:
				'Lists pending AIScelle messages in this mailbox, newest first, headers only (no message body). Titles are in wrappedContent. Every returned entry has already been signature-verified and trust-resolved on this device.',
			inputSchema: {
				cursor: z.string().optional().describe('Opaque pagination cursor, the nextCursor of a previous call.'),
				limit: z.number().int().min(1).max(100).optional(),
			},
			outputSchema: inboxOutputShape,
			annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
		},
		async ({ cursor, limit }, extra) => {
			const conversationId = resolveConversationId(extra)
			if (conversationId) await touchConversationAfterAllowedAction(conversationId)

			const page = await fetchMessagePage({ cursor, limit })

			const items: Array<InboxItem> = []
			for (const message of page.items) {
				try {
					const opened = await openMessageHeader(message)
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
						expiresAt: message.expiresAt,
					})
				} catch (error) {
					if (error instanceof MessageRejectedError) {
						logAgentMailboxEvent(server, { event: 'message_rejected', messageId: message.id })
						continue
					}
					throw error
				}
			}

			// In the text, the cursor is an opaque string the server chose: it
			// goes inside the block, never on the device header line.
			const deviceFields = await appendPendingCount({})
			const wrappedContent = await renderWithDeviceHeader(
				deviceFields,
				JSON.stringify({ items, nextCursor: page.nextCursor }),
				'AIScelle inbox listing, message headers from various senders',
			)

			return {
				content: [{ type: 'text', text: wrappedContent }],
				structuredContent: {
					items: items.map(({ title: _title, ...typed }) => typed),
					nextCursor: page.nextCursor,
					...deviceFields,
					wrappedContent,
				},
			}
		},
	)
}
