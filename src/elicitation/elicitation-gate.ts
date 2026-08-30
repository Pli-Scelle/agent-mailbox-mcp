/**
 * The enforcement point for `tools/send.ts` and `tools/purge.ts`: if a
 * read has taken place, every send and every purge triggers an
 * elicitation, an explicit human confirmation. If the client does not
 * declare the elicitation capability, send and purge are refused after a
 * read. This is the one module that turns `elicitation-store.ts`'s
 * persisted fact into the actual MCP `elicitation/create` request, and
 * the one place where this package's defense actually holds: it puts a
 * human in the loop on the one call that lets data leave. Everything
 * upstream of this file (the policy sandwich, trust levels, tool
 * annotations) is persuasion or convention, a probable mitigation at
 * best, never proven; this module is the one that can actually stop the
 * call.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js'
import type { ServerNotification, ServerRequest } from '@modelcontextprotocol/sdk/types.js'
import { logAgentMailboxEvent } from '../server/logging.js'
import { resolveConversationId } from './conversation-id.js'
import { lookupConversationState, touchConversationAfterAllowedAction } from './elicitation-store.js'

type ToolRequestExtra = RequestHandlerExtra<ServerRequest, ServerNotification>

/**
 * A request budget for a human to actually look at the prompt and answer,
 * not a machine-speed round trip. Chosen generously because refusing a
 * legitimate send outright for taking six minutes to confirm is a worse
 * failure mode than a slow tool call.
 */
const ELICITATION_RESPONSE_TIMEOUT_MS = 5 * 60_000

export type ElicitationGateOutcome =
	| { allowed: true }
	| {
			allowed: false
			reason: 'no_capability' | 'declined' | 'cancelled' | 'request_failed'
	  }

/**
 * The three safe-default cases (no exploitable id; an id with no
 * matching record; an expired record) collapse to `true` through
 * `lookupConversationState`'s own `no_record` bucket -- see that module's
 * doc comment for why folding them together, rather than branching on
 * which of the three applies, is deliberate.
 */
async function mustElicit(conversationId: string | undefined): Promise<boolean> {
	if (!conversationId) return true
	const lookup = await lookupConversationState(conversationId)
	return lookup.status === 'no_record' ? true : lookup.hasRead
}

/**
 * Runs the full elicitation gate for one `send` or `purge` call. The
 * caller is responsible for invoking `commitAllowedAction` (below) once
 * the actual
 * side effect it guards has genuinely completed -- never before, and never
 * on a refusal, or a conversation would get marked "safe" for an action
 * that never happened.
 */
export async function evaluateElicitationGate(
	server: McpServer,
	extra: ToolRequestExtra,
	options: { tool: 'send' | 'purge'; confirmationMessage: string },
): Promise<ElicitationGateOutcome & { conversationId: string | undefined }> {
	const conversationId = resolveConversationId(extra)

	if (!(await mustElicit(conversationId))) {
		return { allowed: true, conversationId }
	}

	const clientCapabilities = server.server.getClientCapabilities()
	if (!clientCapabilities?.elicitation?.form) {
		logAgentMailboxEvent(server, { event: 'elicitation_refused_no_capability', tool: options.tool })
		return { allowed: false, reason: 'no_capability', conversationId }
	}

	let result: Awaited<ReturnType<typeof server.server.elicitInput>>
	try {
		result = await server.server.elicitInput(
			{
				message: options.confirmationMessage,
				requestedSchema: { type: 'object', properties: {} },
			},
			{ timeout: ELICITATION_RESPONSE_TIMEOUT_MS },
		)
	} catch {
		logAgentMailboxEvent(server, { event: 'elicitation_request_failed', tool: options.tool })
		return { allowed: false, reason: 'request_failed', conversationId }
	}

	if (result.action !== 'accept') {
		logAgentMailboxEvent(server, {
			event: 'elicitation_declined',
			tool: options.tool,
			action: result.action,
		})
		return { allowed: false, reason: result.action === 'cancel' ? 'cancelled' : 'declined', conversationId }
	}

	logAgentMailboxEvent(server, { event: 'elicitation_granted', tool: options.tool })
	return { allowed: true, conversationId }
}

/**
 * Called exactly once by `tools/send.ts`/`tools/purge.ts`, only after the
 * guarded HTTP call has actually succeeded. A missing `conversationId`
 * (the first safe-default case) has no key to persist under, so there is
 * nothing to touch: that conversation stays permanently on the
 * "no exploitable identifier" path, unconditionally elicited every time,
 * which is the correct standing behaviour for it, not a gap to close here.
 */
export async function commitAllowedAction(conversationId: string | undefined): Promise<void> {
	if (!conversationId) return
	await touchConversationAfterAllowedAction(conversationId)
}
