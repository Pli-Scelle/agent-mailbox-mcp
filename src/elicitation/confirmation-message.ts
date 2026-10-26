/**
 * The text a confirmation prompt shows the person, one line per field. `send` and `purge` build
 * their prompt here, and the bench's copy is checked against these builders by its parity spec.
 */
import { CONFIRMATION_EXCERPT_CHARS, CONFIRMATION_SCOPE_NOTICE, oneLineExcerpt } from './elicitation-gate.js'

export function buildSendConfirmationMessage(params: { correspondent: string; title: string; body: string }): string {
	return [
		`Confirmer l'envoi d'un message AIScellé à ${params.correspondent} ?`,
		`Titre : ${oneLineExcerpt(params.title, CONFIRMATION_EXCERPT_CHARS)}`,
		`Corps : ${oneLineExcerpt(params.body, CONFIRMATION_EXCERPT_CHARS)}`,
		CONFIRMATION_SCOPE_NOTICE,
	].join('\n')
}

export function buildPurgeConfirmationMessage(params: { messageId: string; title: string | undefined }): string {
	return [
		`Confirmer la suppression du message AIScellé ${params.messageId} de cette boîte ?`,
		`Titre : ${params.title === undefined ? 'indisponible' : oneLineExcerpt(params.title, CONFIRMATION_EXCERPT_CHARS)}`,
		CONFIRMATION_SCOPE_NOTICE,
	].join('\n')
}
