/**
 * `pair`: the human-run half of device registration. Never invoked by the
 * MCP server itself -- see pairing-registration.ts's docblock for why a
 * pairing code must stay a deliberate, human-initiated action.
 *
 * Chains straight into `login` (browser flow) once registration succeeds,
 * by default: a device that is paired but not signed in cannot do anything
 * yet, and making the human type a second command for what is really the
 * second half of one setup step is exactly the gap that stranded a user on
 * 2026-08-30 (see config/cli-invocation.ts's docblock). `--no-login` opts
 * out, for a pairing done in a script or on a browserless machine that
 * needs `login --device` run separately afterwards.
 *
 * `login` is also what finishes the pairing, by linking this device's
 * mailbox identity (cli/login.ts): registration alone leaves the server
 * holding a pairing row that expires within the hour and no device at all
 * on the owner's management tab. So a failure of the chained step leaves
 * the setup genuinely unfinished, and says so -- while making clear that
 * the registration is saved and the code must not be spent again.
 */
import { hostname } from 'node:os'
import { parseArgs } from 'node:util'
import { cliCommand } from '../config/cli-invocation.js'
import { registerDevice } from '../oauth/pairing-registration.js'
import { MailboxLinkError, runLoginCommand } from './login.js'
import { printUsageAndExit } from './usage.js'

export async function runPairCommand(argv: Array<string>): Promise<void> {
	const { values } = parseArgs({
		args: argv,
		options: {
			code: { type: 'string' },
			name: { type: 'string' },
			'no-login': { type: 'boolean', default: false },
		},
		strict: true,
	})

	if (!values.code) printUsageAndExit('pair: --code <PAIRING_CODE> is required.')
	const deviceName = values.name ?? hostname()

	const { record } = await registerDevice({ pairingCode: values.code, deviceName })

	console.log(`Device registered (client_id: ${record.clientId}).`)

	if (values['no-login']) {
		console.log(
			`Next: run \`${cliCommand('login')}\` to authenticate this device and finish the pairing. Do it within the hour, after which the pairing expires and a new code is needed.`,
		)
		return
	}

	try {
		await runLoginCommand([])
	} catch (error: unknown) {
		const message = error instanceof Error ? error.message : String(error)
		console.error(
			`This device's registration is saved (client_id: ${record.clientId}); the pairing is not finished yet: ${message}`,
		)
		// A failed link already says what to do, including the one case
		// where pairing again IS the answer (an expired pairing). Adding
		// the sign-in advice on top would contradict it.
		if (!(error instanceof MailboxLinkError)) {
			console.error(
				`Run \`${cliCommand('login')}\` to retry, within the hour. There is no need to pair again, and the code you used is already spent.`,
			)
		}
		process.exitCode = 1
	}
}
