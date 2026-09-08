/**
 * The enforcement point for `tools/send.ts` and `tools/purge.ts`: if a
 * read has taken place, every send and every purge must clear this gate.
 * It clears in one of two ways, never in a third. With a human present,
 * an elicitation, an explicit confirmation; if the client does not declare
 * the elicitation capability, send and purge are refused after a read. In
 * unattended mode (config/unattended-mode.ts), declared at launch by a
 * human editing a configuration file no message can reach, the
 * confirmation is replaced by a check this machine can make on its own:
 * the outgoing address must already be ratified locally. That is a
 * substitution, not a removal -- an injected message can name any address
 * it likes, and cannot put one on that list.
 *
 * This is the one module that turns `elicitation-store.ts`'s
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
import { findAllowlistEntry } from '../trust/allowlist-store.js'
import { HOST_PROCESS_KEY_PREFIX, resolveConversationId } from './conversation-id.js'
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
			reason: 'no_capability' | 'declined' | 'cancelled' | 'request_failed' | 'unratified_recipient'
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
 * What replaces the human in unattended mode, and the reason that mode is
 * not simply "the gate turned off": the outgoing address must already carry
 * a ratification a human performed on THIS machine (trust/ratify.ts, never
 * callable by an agent). The server's own view of who is ratified is
 * deliberately ignored here, exactly as `trust/resolve-trust.ts` ignores it
 * at read time: a compromised server must not be able to widen this
 * device's trust by answering a request.
 */
async function isRecipientRatifiedLocally(recipientAddress: string | undefined): Promise<boolean> {
	if (!recipientAddress) return false
	return (await findAllowlistEntry(recipientAddress))?.ratifiedLocally ?? false
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
	options: {
		tool: 'send' | 'purge'
		/**
		 * Built on demand, not passed ready-made: composing it costs a read of
		 * this device's allowlist (`tools/send.ts` names the correspondent),
		 * and every path through this gate other than the elicitation itself
		 * throws that work away -- the frictionless path, the capability
		 * refusal, and all of unattended mode.
		 */
		buildConfirmationMessage: () => string | Promise<string>
		unattended: boolean
		/** Absent for `purge`, which has no recipient by construction. */
		recipientAddress?: string
	},
): Promise<ElicitationGateOutcome & { conversationId: string | undefined }> {
	const conversationId = resolveConversationId(extra)

	logAgentMailboxEvent(server, {
		event: 'elicitation_gate_evaluated',
		tool: options.tool,
		conversationIdSource: conversationId?.startsWith(HOST_PROCESS_KEY_PREFIX) ? 'host_process' : 'client_meta',
	})

	if (!(await mustElicit(conversationId))) {
		return { allowed: true, conversationId }
	}

	if (options.unattended) {
		// `purge` clears unconditionally here: it names no recipient, it only
		// ever deletes from this machine's own mailbox, and an unattended agent
		// that cannot free its own quota blocks itself with nothing gained.
		if (options.tool === 'purge' || (await isRecipientRatifiedLocally(options.recipientAddress))) {
			logAgentMailboxEvent(server, { event: 'elicitation_bypassed_unattended', tool: options.tool })
			return { allowed: true, conversationId }
		}
		logAgentMailboxEvent(server, { event: 'elicitation_refused_unratified_recipient', tool: options.tool })
		return { allowed: false, reason: 'unratified_recipient', conversationId }
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
				message: await options.buildConfirmationMessage(),
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
