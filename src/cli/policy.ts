/**
 * `pliscelle-mcp policy`: the only writer of the local anti-injection
 * policy kill switch (policy/policy-toggle.ts). Human-run, on purpose --
 * see that module's doc comment for why this can never become an MCP
 * tool.
 */
import { parseArgs } from 'node:util'
import { isPolicyEnabled, setPolicyEnabled } from '../policy/policy-toggle.js'
import { printUsageAndExit } from './usage.js'

export async function runPolicyCliCommand(argv: Array<string>): Promise<void> {
	const { values } = parseArgs({
		args: argv,
		options: {
			status: { type: 'boolean', default: false },
			enable: { type: 'boolean', default: false },
			disable: { type: 'boolean', default: false },
		},
		strict: true,
	})

	const flagsSet = [values.status, values.enable, values.disable].filter(Boolean).length
	if (flagsSet !== 1) {
		printUsageAndExit('policy: exactly one of --status, --enable, or --disable is required.')
	}

	if (values.status) {
		const enabled = await isPolicyEnabled()
		console.log(`AIScelle anti-injection policy: ${enabled ? 'enabled' : 'DISABLED'}`)
		return
	}

	if (values.disable) {
		await setPolicyEnabled(false)
		console.log(
			'AIScelle anti-injection policy DISABLED on this device. Message content shown to your agent will no longer carry the untrusted-content warning. This setting is local to this device only.',
		)
		return
	}

	await setPolicyEnabled(true)
	console.log('AIScelle anti-injection policy enabled on this device.')
}
