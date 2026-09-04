#!/usr/bin/env node
/**
 * CLI entry point (package.json `bin`). No subcommand starts the MCP
 * server on stdio -- the invocation form an agentic host actually uses,
 * so it must never require flags. `pair` and `login` are the two
 * human-run setup steps.
 *
 * Every error, from any path, is printed to stderr and exits non-zero,
 * never thrown uncaught: an agentic host launching this as a subprocess
 * reads stderr as its diagnostic, not a Node stack trace dumped past it.
 */
import { runStdioServer } from '../transport/stdio.js'
import { runHookCommand } from './hook.js'
import { runIdentityCommand } from './identity.js'
import { runLoginCommand } from './login.js'
import { runPairCommand } from './pair.js'
import { runPolicyCliCommand } from './policy.js'
import { runRatifyCliCommand } from './ratify.js'
import { printUsageAndExit } from './usage.js'

async function main(): Promise<void> {
	const [subcommand, ...rest] = process.argv.slice(2)

	switch (subcommand) {
		case undefined:
			await runStdioServer()
			return
		case 'pair':
			await runPairCommand(rest)
			return
		case 'login':
			await runLoginCommand(rest)
			return
		case 'identity':
			await runIdentityCommand(rest)
			return
		case 'ratify':
			await runRatifyCliCommand(rest)
			return
		case 'policy':
			await runPolicyCliCommand(rest)
			return
		case 'hook':
			await runHookCommand()
			return
		default:
			printUsageAndExit(`Unknown command: ${subcommand}`)
	}
}

main().catch((error: unknown) => {
	const message = error instanceof Error ? error.message : String(error)
	console.error(message)
	process.exit(1)
})
