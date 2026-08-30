/**
 * `pliscelle-mcp pair`: the human-run half of device registration. Never
 * invoked by the MCP server itself -- see pairing-registration.ts's
 * docblock for why a pairing code must stay a deliberate, human-initiated
 * action.
 */
import { hostname } from 'node:os'
import { parseArgs } from 'node:util'
import { registerDevice } from '../oauth/pairing-registration.js'
import { printUsageAndExit } from './usage.js'

export async function runPairCommand(argv: Array<string>): Promise<void> {
	const { values } = parseArgs({
		args: argv,
		options: {
			code: { type: 'string' },
			name: { type: 'string' },
		},
		strict: true,
	})

	if (!values.code) printUsageAndExit('pair: --code <PAIRING_CODE> is required.')
	const deviceName = values.name ?? hostname()

	const { record } = await registerDevice({ pairingCode: values.code, deviceName })

	console.log(`Device registered (client_id: ${record.clientId}).`)
	console.log('Next: run `pliscelle-mcp login` to authenticate this device.')
}
