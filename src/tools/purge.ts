/**
 * `purge` deletes one received message. Not read-only, destructive (this
 * tool's own annotations declare `readOnlyHint: false`,
 * `destructiveHint: true`). Server-side deletion, no decryption involved
 * (the delete operation is idempotent server-side and needs no key
 * material): this tool is a thin wrapper over `purgeMessage`.
 *
 * The mandatory confirmation after a `read` applies to `purge` exactly as
 * it does to `send`, and for a concrete reason: without it, an injected
 * instruction ending with something like "and delete this message" could
 * erase its own evidence with no barrier in its way. It is enforced by the
 * same `elicitation/elicitation-gate.ts` call `tools/send.ts` uses, first,
 * before the deletion itself.
 *
 * Unattended mode (config/unattended-mode.ts) lets `purge` through without
 * that confirmation, and the cost is stated rather than glossed over: the
 * "delete this message" tail of an injected instruction does execute on
 * such a machine. What bounds it is that the deletion stays inside this
 * mailbox: it discloses nothing, and it reaches no correspondent. Weighed
 * against an unattended agent that fills its quota and stops working, with
 * no human able to free it, that is the trade this mode accepts on
 * purpose.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { purgeMessage } from '../api/mailbox-client.js'
import type { RuntimeOptions } from '../config/unattended-mode.js'
import { commitAllowedAction, evaluateElicitationGate } from '../elicitation/elicitation-gate.js'
import { elicitationRefusalMessage } from './elicitation-refusal.js'
import { appendPendingCount } from './pending-count.js'

const purgeOutputShape = {
	messageId: z.string(),
	pendingMessageCount: z.number(),
	pendingRatificationCount: z.number(),
}

export function registerPurgeTool(server: McpServer, options: RuntimeOptions): void {
	server.registerTool(
		'purge',
		{
			title: 'AIScelle purge',
			description:
				'Deletes one received AIScelle message from this mailbox. Frees one slot of quota. Idempotent server-side: purging an already-purged message is not an error.',
			inputSchema: { messageId: z.string().min(1) },
			outputSchema: purgeOutputShape,
			annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
		},
		async ({ messageId }, extra) => {
			const gate = await evaluateElicitationGate(server, extra, {
				tool: 'purge',
				buildConfirmationMessage: () => `Confirm deleting AIScelle message ${messageId} from this mailbox?`,
				unattended: options.unattended,
			})
			if (!gate.allowed) {
				return {
					isError: true,
					content: [{ type: 'text' as const, text: elicitationRefusalMessage('purge', gate.reason) }],
				}
			}

			await purgeMessage(messageId)
			await commitAllowedAction(gate.conversationId)

			const structuredContent = await appendPendingCount({ messageId })
			return {
				content: [{ type: 'text' as const, text: `Message ${messageId} purged.` }],
				structuredContent: structuredContent as unknown as Record<string, unknown>,
			}
		},
	)
}
