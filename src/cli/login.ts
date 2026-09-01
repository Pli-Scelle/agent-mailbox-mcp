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
 * is the right step to carry it, is in docs/features/ai-scelle.md 6.2.
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
					`Open ${prompt.verificationUri} on any device with a browser and enter code: ${prompt.userCode}`,
				)
				if (prompt.verificationUriComplete) {
					console.log(`Or open directly: ${prompt.verificationUriComplete}`)
				}
				console.log('Waiting for approval...')
			},
		})
	} else {
		await runAuthorizationCodeLogin({
			configuration,
			redirectUri: record.redirectUri,
			onAuthorizationUrl: (url) => {
				console.log('Opening your browser to sign in. If it does not open automatically, visit:')
				console.log(url.toString())
			},
		})
	}

	// Signing in and owning a mailbox are two different states, and only
	// the second one is visible to the human who paired: a failure here is
	// never a failure to sign in, and carries its own instructions, which
	// is why `pair` recognises this error and adds none of its own.
	try {
		const address = await ensureMailboxLinked()
		console.log(`Signed in. This device is now paired with mailbox ${address} and appears in your AIScelle tab.`)
	} catch (error: unknown) {
		const message = error instanceof Error ? error.message : String(error)
		throw new MailboxLinkError(
			`Signed in, but this device could not be registered on your mailbox: ${message}\nRun \`${cliCommand('login')}\` again to retry. If the pairing has expired (it lasts one hour), generate a new code from the AIScelle tab and run \`${cliCommand('pair')}\` once more.`,
			{ cause: error },
		)
	}

	console.log(`\`${CLI_INVOCATION}\` (no arguments) starts the MCP server for your agentic client.`)
}
