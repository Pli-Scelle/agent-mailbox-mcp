/**
 * The invocation this package's own human-facing messages must name.
 *
 * `package.json` declares a `pliscelle-mcp` binary, but this package's only
 * documented install path is `npx @pliscelle/agent-mailbox-mcp` (see
 * README.md): that installs nothing permanent, so the bare `pliscelle-mcp`
 * command does not exist on a user's machine unless they installed the
 * package globally themselves. Every message a human reads -- CLI stdout,
 * thrown error messages, MCP tool descriptions -- must therefore tell them
 * to run through `npx`, never the bare binary name.
 *
 * Found in production on 2026-08-30: `pair` printed "run `pliscelle-mcp
 * login`" as its very next step, and that command did not exist on the
 * machine that had just run `npx @pliscelle/agent-mailbox-mcp pair`.
 *
 * A code comment that names the subcommand itself as a call-site reference
 * (a docblock like "`pair`: the human-run half of device registration") is
 * not what this constant is for -- only strings a human actually reads at
 * runtime, or an agent reads as a tool description, go through it.
 */
export const CLI_INVOCATION = 'npx @pliscelle/agent-mailbox-mcp'

export function cliCommand(subcommand: string): string {
	return `${CLI_INVOCATION} ${subcommand}`
}
