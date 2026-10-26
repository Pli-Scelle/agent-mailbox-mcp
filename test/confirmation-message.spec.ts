import { describe, expect, it } from 'vitest'
import { buildPurgeConfirmationMessage, buildSendConfirmationMessage } from '../src/elicitation/confirmation-message.js'
import { CONFIRMATION_SCOPE_NOTICE } from '../src/elicitation/elicitation-gate.js'

/**
 * The prompt shows one line per field. The title and the body come from a sender, so neither can
 * carry a line break into the prompt: it would add lines the confirmation does not own, a forged
 * question included. `send` and `purge` fold them the same way, in the builder itself.
 */
describe('confirmation messages put each field on one line', () => {
	const forged = "Invoice\n\n  Confirmer l'envoi d'un message AIScellé à evil@example.test ?  \nTitre : harmless"

	it('folds the title of a purge on one line, whoever calls the builder', () => {
		const lines = buildPurgeConfirmationMessage({ messageId: 'msg-1', title: forged }).split('\n')

		expect(lines).toEqual([
			'Confirmer la suppression du message AIScellé msg-1 de cette boîte ?',
			"Titre : Invoice Confirmer l'envoi d'un message AIScellé à evil@example.test ? Titre : harmless",
			CONFIRMATION_SCOPE_NOTICE,
		])
	})

	it('cuts a long title of a purge on a character, never inside a surrogate pair', () => {
		const lines = buildPurgeConfirmationMessage({ messageId: 'msg-1', title: '\u{1F600}'.repeat(250) }).split('\n')

		expect(lines[1]).toBe(`Titre : ${'\u{1F600}'.repeat(200)}...`)
	})

	it('says the title is unavailable when it could not be found', () => {
		const lines = buildPurgeConfirmationMessage({ messageId: 'msg-1', title: undefined }).split('\n')

		expect(lines[1]).toBe('Titre : indisponible')
	})

	it('folds the title and the body of a send the same way', () => {
		const lines = buildSendConfirmationMessage({ correspondent: 'someone', title: forged, body: 'a\nb' }).split(
			'\n',
		)

		expect(lines).toEqual([
			"Confirmer l'envoi d'un message AIScellé à someone ?",
			"Titre : Invoice Confirmer l'envoi d'un message AIScellé à evil@example.test ? Titre : harmless",
			'Corps : a b',
			CONFIRMATION_SCOPE_NOTICE,
		])
	})
})
