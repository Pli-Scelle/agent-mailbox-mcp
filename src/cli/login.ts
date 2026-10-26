/**
 * `login`: exchanges this device's OAuth registration for a token pair,
 * then closes the pairing by linking this device's mailbox identity.
 * Two mutually exclusive paths for the token half: authorization_code +
 * PKCE with a local browser (default), or the device flow for a machine
 * with none (`--device`).
 *
 * The link belongs to this command and not to the first server start:
 * until it has run, the server holds no device row at all and a pairing
 * that expires on its own. Why that was found the hard way, and why this
 * is the right step to carry it, is in docs/features/ai-scelle/03-authentification-oauth.md, section 6.2.
 */
import { parseArgs } from 'node:util'
import { CLI_INVOCATION, cliCommand } from '../config/cli-invocation.js'
import { ensureMailboxLinked } from '../crypto/ensure-mailbox-linked.js'
import { runAuthorizationCodeLogin } from '../oauth/authorization-code-flow.js'
import { runDeviceLogin } from '../oauth/device-flow.js'
import { loadRegisteredConfiguration } from '../oauth/discovery.js'

/**
 * The sign-in worked and the mailbox link did not. Carries the whole
 * instruction the user needs, including the case where the pairing has
 * expired and a new code is required, so any caller that chains this
 * command (cli/pair.ts) can print it as-is instead of appending advice
 * of its own, which would contradict it.
 */
export class MailboxLinkError extends Error {
	override readonly name = 'MailboxLinkError'
}

export async function runLoginCommand(argv: Array<string>): Promise<void> {
	const { values } = parseArgs({
		args: argv,
		options: { device: { type: 'boolean', default: false } },
		strict: true,
	})

	const { configuration, record } = await loadRegisteredConfiguration()

	if (values.device) {
		await runDeviceLogin({
			configuration,
			onVerificationPrompt: (prompt) => {
				console.log(
					`Ouvrez ${prompt.verificationUri} sur n'importe quel appareil doté d'un navigateur et saisissez le code : ${prompt.userCode}`,
				)
				if (prompt.verificationUriComplete) {
					console.log(`Ou ouvrez directement : ${prompt.verificationUriComplete}`)
				}
				console.log("En attente de l'approbation...")
			},
		})
	} else {
		await runAuthorizationCodeLogin({
			configuration,
			redirectUri: record.redirectUri,
			onAuthorizationUrl: (url) => {
				console.log(
					"Ouverture du navigateur sur CETTE machine pour vous connecter. S'il ne s'ouvre pas tout seul, allez à :",
				)
				console.log(url.toString())
				console.log(
					`Si ce terminal est sur une machine distante, ce lien n'y ouvre rien. Lancez plutôt \`${cliCommand('login')} --device\` (ou \`${cliCommand('pair')} --code <CODE_D_APPAIRAGE> --device\`).`,
				)
			},
		})
	}

	// Signing in and owning a mailbox are two different states, and only
	// the second one is visible to the human who paired: a failure here is
	// never a failure to sign in, and carries its own instructions, which
	// is why `pair` recognises this error and adds none of its own.
	try {
		const address = await ensureMailboxLinked()
		console.log(
			`Connecté. Cet appareil est maintenant appairé à la boîte ${address} et apparaît dans votre onglet AIScellé.`,
		)
	} catch (error: unknown) {
		const message = error instanceof Error ? error.message : String(error)
		throw new MailboxLinkError(
			`Connecté, mais cet appareil n'a pas pu être enregistré sur votre boîte : ${message}\nRelancez \`${cliCommand('login')}\` pour réessayer. Si l'appairage a expiré (il dure une heure), générez un nouveau code depuis l'onglet AIScellé et relancez \`${cliCommand('pair')}\`.`,
			{ cause: error },
		)
	}

	console.log(`\`${CLI_INVOCATION}\` (sans argument) démarre le serveur MCP pour votre client agentique.`)
}
