/**
 * `pliscelle-mcp ratify`: the human-run half of the correspondent
 * ratification gesture. See trust/ratify.ts's module doc comment for why
 * this is a CLI command and structurally cannot become an MCP tool.
 */
import { parseArgs } from 'node:util'
import { runRatifyCommand } from '../trust/ratify.js'
import { printUsageAndExit } from './usage.js'

export async function runRatifyCliCommand(argv: Array<string>): Promise<void> {
	const { values } = parseArgs({
		args: argv,
		options: {
			'sender-id': { type: 'string' },
			list: { type: 'boolean', default: false },
			yes: { type: 'boolean', default: false },
		},
		strict: true,
	})

	if (!values.list && !values['sender-id']) {
		printUsageAndExit('ratify: either --list or --sender-id <ID> is required.')
	}

	await runRatifyCommand({ senderId: values['sender-id'], list: values.list, yes: values.yes })
}
