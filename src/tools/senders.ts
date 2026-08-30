/**
 * `senders` lists authorized correspondents for this mailbox, one page at a
 * time, by cursor. Read-only, idempotent. Deliberately mixes server-reported
 * fields (address, label, server `trustLevel`, `isActive`) with this
 * DEVICE's own local ratification state (`ratifiedLocally`): these two can
 * disagree by design (an entry the server calls ratified may never have
 * been ratified on THIS device), and this tool is exactly where an agent --
 * or the human reading its output -- needs to see that gap, not have it
 * hidden.
 *
 * Not the same call site `trust/reconcile.ts` uses for heartbeat
 * reconciliation: this tool exposes one page at a time and only READS the
 * local mirror for display, it never writes to it -- merging a partial page
 * into the local store would risk purging entries this page did not
 * include (see `fetchAllSenders`'s doc comment on why reconciliation needs
 * the FULL set). `pliscelle-mcp ratify` runs its own full reconciliation
 * before doing anything (trust/ratify.ts), so a candidate this tool has not
 * yet seen is still ratifiable.
 *
 * Not wrapped in the policy sandwich (policy/injection-policy.ts): `label`
 * is set on THIS device by a human, via ratification, never by the
 * correspondent, so it carries none of the injection risk a message title
 * or body does. Also touches this conversation's elicitation record the
 * same way `inbox`/`search` do -- see `touchConversationAfterAllowedAction`'s
 * doc comment.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { fetchSenderPage } from '../api/mailbox-client.js'
import { resolveConversationId } from '../elicitation/conversation-id.js'
import { touchConversationAfterAllowedAction } from '../elicitation/elicitation-store.js'
import { readAllowlist } from '../trust/allowlist-store.js'
import { appendPendingCount } from './pending-count.js'

const senderItemSchema = z.object({
	id: z.string(),
	address: z.string(),
	label: z.string(),
	trustLevel: z.enum(['data', 'instruction']),
	isActive: z.boolean(),
	ratifiedLocally: z.boolean(),
	ratifiedOnServer: z.boolean(),
})

const sendersOutputShape = {
	items: z.array(senderItemSchema),
	nextCursor: z.string().nullable(),
	pendingMessageCount: z.number(),
}

export function registerSendersTool(server: McpServer): void {
	server.registerTool(
		'senders',
		{
			title: 'AIScelle correspondents',
			description:
				'Lists authorized correspondents for this mailbox. `ratifiedLocally` reflects THIS device only: a correspondent the server reports as ratified may still be untrusted here until a human runs `pliscelle-mcp ratify`.',
			inputSchema: {
				cursor: z.string().optional(),
				limit: z.number().int().min(1).max(100).optional(),
			},
			outputSchema: sendersOutputShape,
			annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
		},
		async ({ cursor, limit }, extra) => {
			const conversationId = resolveConversationId(extra)
			if (conversationId) await touchConversationAfterAllowedAction(conversationId)

			const page = await fetchSenderPage({ cursor, limit })
			const local = await readAllowlist()
			const localByServerId = new Map(local.map((entry) => [entry.serverSenderId, entry]))

			const items = page.items.map((entry) => ({
				id: entry.id,
				address: entry.senderAddress,
				label: entry.label,
				trustLevel: entry.trustLevel,
				isActive: entry.isActive,
				ratifiedLocally: localByServerId.get(entry.id)?.ratifiedLocally ?? false,
				ratifiedOnServer: entry.ratifiedAt !== null,
			}))

			const structuredContent = await appendPendingCount({ items, nextCursor: page.nextCursor })

			return {
				content: [{ type: 'text', text: JSON.stringify(structuredContent) }],
				structuredContent: structuredContent as unknown as Record<string, unknown>,
			}
		},
	)
}
