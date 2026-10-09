/**
 * Shared refusal text for `tools/send.ts` and `tools/purge.ts` when
 * `elicitation/elicitation-gate.ts` does not allow the call through:
 * `no_capability` is the package's own explicit rule: if the client does
 * not declare the elicitation capability, `send` and `purge` are refused
 * after a read; `declined`/`cancelled`/`request_failed` are this package's
 * own choice to fail closed on anything short of an explicit accept, since
 * only a confirmed accept is ever described as unlocking the action, never
 * what should happen on anything else; `unratified_recipient` is the
 * unattended-mode refusal, and names the human gesture that lifts it,
 * because the agent reading it has no other way to learn what would.
 *
 * The texts are French, with accents, by product decision (issue #1362):
 * the connector has no FR/EN message table.
 */
import type { ElicitationGateOutcome } from '../elicitation/elicitation-gate.js'

export function elicitationRefusalMessage(
	tool: 'send' | 'purge',
	reason: Exclude<ElicitationGateOutcome, { allowed: true }>['reason'],
): string {
	switch (reason) {
		case 'no_capability':
			return `Cette conversation a lu un message AIScelle, ce qui exige une confirmation humaine avant ${tool}. Ce client ne gère pas les demandes de confirmation, donc ${tool} est refusé.`
		case 'declined':
			return `${tool} n'a pas été confirmé par l'utilisateur et a été annulé.`
		case 'cancelled':
			return `La demande de confirmation pour ${tool} a été fermée sans réponse. ${tool} a été annulé.`
		case 'request_failed':
			return `La demande de confirmation pour ${tool} n'a pas pu aboutir. ${tool} a été annulé.`
		case 'unratified_recipient':
			return `Ce connecteur tourne en mode sans surveillance, où ${tool} n'atteint qu'un correspondant déjà ratifié sur cette machine. Ce destinataire n'en fait pas partie. Rien n'a été chiffré, rien n'a été envoyé. Un humain doit ratifier ce correspondant sur cette machine avant qu'il puisse être joint.`
	}
}
