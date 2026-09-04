/**
 * `inbox` lists pending message headers, paginated by cursor. Read-only,
 * idempotent. Every message returned here has already passed signature
 * verification (trust/resolve-trust.ts): a message whose signature verifies
 * against no locally ratified OR locally-known key is silently dropped from
 * this list, logged locally, never surfaced to the agent as a row with an
 * error in it -- surfacing it as data would itself be a form of trusting
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
 * read, is not needlessly gated -- see `touchConversationAfterAllowedAction`'s
 * own doc comment for why this is safe.
 *
 * `title` is deliberately ABSENT from `structuredContent`/`outputSchema`,
 * correction after review: `structuredContent` is a first-class MCP
 * response channel, filled whenever `outputSchema` is declared, and an
 * agentic host may render it to the model directly, in parallel with or
 * instead of `content`. Putting sender-controlled text there would hand
 * that host the title completely unwrapped, defeating the sandwich this
 * file otherwise applies. `title` still reaches the agent, but ONLY inside
 * the sandwiched JSON blob in `content[0].text` below -- never as a bare,
 * independently-typed field a host could surface on its own.
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

/** The safe, structured shape: never a sender-controlled text field. See the module doc comment. */
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

/** Same as `inboxItemSchema` plus the sender-controlled `title`, used ONLY to build the sandwiched `content[0].text` JSON blob, never `structuredContent`. */
interface InboxItemWithTitle extends z.infer<typeof inboxItemSchema> {
	title: string
}

const inboxOutputShape = {
	items: z.array(inboxItemSchema),
	nextCursor: z.string().nullable(),
	pendingMessageCount: z.number(),
	pendingRatificationCount: z.number(),
}

export function registerInboxTool(server: McpServer): void {
	server.registerTool(
		'inbox',
		{
			title: 'AIScelle inbox',
			description:
				'Lists pending AIScelle messages in this mailbox, newest first, headers only (no message body). Every returned entry has already been signature-verified and trust-resolved on this device.',
			inputSchema: {
				cursor: z.string().optional().describe('Opaque pagination cursor from a previous call’s nextCursor.'),
				limit: z.number().int().min(1).max(100).optional(),
			},
			outputSchema: inboxOutputShape,
			annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
		},
		async ({ cursor, limit }, extra) => {
			const conversationId = resolveConversationId(extra)
			if (conversationId) await touchConversationAfterAllowedAction(conversationId)

			const page = await fetchMessagePage({ cursor, limit })

			const items: Array<InboxItemWithTitle> = []
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

			const withTitles = await appendPendingCount({ items, nextCursor: page.nextCursor })
			// Strip the sender-controlled `title` before this reaches
			// `structuredContent`: see the module doc comment.
			const structuredContent = stripSenderControlledTitles(withTitles)

			return {
				content: [
					{
						type: 'text',
						text: await wrapUntrustedContent(
							JSON.stringify(withTitles),
							'AIScelle inbox listing, message headers from various senders',
						),
					},
				],
				structuredContent: structuredContent as unknown as Record<string, unknown>,
			}
		},
	)
}
