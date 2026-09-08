/**
 * Shared refusal text for `tools/send.ts` and `tools/purge.ts` when
 * `elicitation/elicitation-gate.ts` does not allow the call through:
 * `no_capability` is the package's own explicit rule -- if the client does
 * not declare the elicitation capability, `send` and `purge` are refused
 * after a read; `declined`/`cancelled`/`request_failed` are this package's
 * own choice to fail closed on anything short of an explicit accept, since
 * only a confirmed accept is ever described as unlocking the action, never
 * what should happen on anything else; `unratified_recipient` is the
 * unattended-mode refusal, and names the human gesture that lifts it,
 * because the agent reading it has no other way to learn what would.
 */
import type { ElicitationGateOutcome } from '../elicitation/elicitation-gate.js'

export function elicitationRefusalMessage(
	tool: 'send' | 'purge',
	reason: Exclude<ElicitationGateOutcome, { allowed: true }>['reason'],
): string {
	switch (reason) {
		case 'no_capability':
			return `This conversation has read an AIScelle message, which requires human confirmation before ${tool}. This client does not support confirmation prompts, so ${tool} is refused.`
		case 'declined':
			return `${tool} was not confirmed by the user and has been cancelled.`
		case 'cancelled':
			return `The confirmation prompt for ${tool} was dismissed without an answer. ${tool} has been cancelled.`
		case 'request_failed':
			return `The confirmation prompt for ${tool} could not be completed. ${tool} has been cancelled.`
		case 'unratified_recipient':
			return `This connector runs in unattended mode, where ${tool} only goes through towards a correspondent already ratified on this machine. This recipient is not one. Nothing was encrypted, nothing was sent. A human must ratify this correspondent on this machine before it can be reached.`
	}
}
