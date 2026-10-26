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
		printUsageAndExit('policy : exactement une option parmi --status, --enable ou --disable est requise.')
	}

	if (values.status) {
		const enabled = await isPolicyEnabled()
		console.log(`Politique anti-injection AIScellé : ${enabled ? 'activée' : 'DÉSACTIVÉE'}`)
		return
	}

	if (values.disable) {
		await setPolicyEnabled(false)
		console.log(
			"Politique anti-injection AIScellé DÉSACTIVÉE sur cet appareil. Le contenu des messages montré à votre agent ne portera plus l'avertissement de contenu non fiable. Ce réglage ne vaut que pour cet appareil.",
		)
		return
	}

	await setPolicyEnabled(true)
	console.log('Politique anti-injection AIScellé activée sur cet appareil.')
}
