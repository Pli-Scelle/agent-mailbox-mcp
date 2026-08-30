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
 * A failure of the chained login must never look like pairing itself
 * failed: the device registration is already written to disk by the time
 * login runs, so a login failure here is reported as what it is, a second,
 * independent step that can simply be retried with `login`.
 */
import { hostname } from 'node:os'
import { parseArgs } from 'node:util'
import { cliCommand } from '../config/cli-invocation.js'
import { registerDevice } from '../oauth/pairing-registration.js'
import { runLoginCommand } from './login.js'
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
		console.log(`Next: run \`${cliCommand('login')}\` to authenticate this device.`)
		return
	}

	try {
		await runLoginCommand([])
	} catch (error: unknown) {
		const message = error instanceof Error ? error.message : String(error)
		console.error(
			`Pairing succeeded and is saved on this device (client_id: ${record.clientId}); this only failed to sign in: ${message}`,
		)
		console.error(`Run \`${cliCommand('login')}\` to retry. There is no need to pair again.`)
		process.exitCode = 1
	}
}
