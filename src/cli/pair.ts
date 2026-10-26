/**
 * `pair`: the human-run half of device registration. Never invoked by the
 * MCP server itself: see pairing-registration.ts's docblock for why a
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
 * the setup genuinely unfinished, and says so, while making clear that
 * the registration is saved and the code must not be spent again.
 *
 * `--device` forwards straight to the chained `login`, for a pairing run
 * from a remote shell: the default browser flow opens a local server and a
 * `127.0.0.1` link that only makes sense on the machine `pair` runs on, so
 * a remote user needs the device flow's separate verification link instead
 * (see login.ts and oauth/device-flow.ts).
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
			device: { type: 'boolean', default: false },
		},
		strict: true,
	})

	if (!values.code) printUsageAndExit('pair : --code <CODE_D_APPAIRAGE> est requis.')
	const deviceName = values.name ?? hostname()

	const { record } = await registerDevice({ pairingCode: values.code, deviceName })

	console.log(`Appareil enregistré (client_id : ${record.clientId}).`)

	if (values['no-login']) {
		console.log(
			`Suite : lancez \`${cliCommand('login')}\` pour authentifier cet appareil et terminer l'appairage. Faites-le dans l'heure : passé ce délai, l'appairage expire et il faut un nouveau code.`,
		)
		return
	}

	try {
		await runLoginCommand(values.device ? ['--device'] : [])
	} catch (error: unknown) {
		const message = error instanceof Error ? error.message : String(error)
		console.error(
			`L'enregistrement de cet appareil est sauvegardé (client_id : ${record.clientId}) ; l'appairage n'est pas encore terminé : ${message}`,
		)
		// A failed link already says what to do, including the one case
		// where pairing again IS the answer (an expired pairing). Adding
		// the sign-in advice on top would contradict it.
		if (!(error instanceof MailboxLinkError)) {
			console.error(
				`Relancez \`${cliCommand('login')}\` dans l'heure. Il est inutile de refaire l'appairage : le code utilisé est déjà consommé.`,
			)
		}
		process.exitCode = 1
	}
}
