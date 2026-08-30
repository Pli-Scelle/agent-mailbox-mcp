import { CLI_INVOCATION } from '../config/cli-invocation.js'

/**
 * Spelled with the `npx` invocation rather than the bare binary name, for
 * the reason config/cli-invocation.ts documents: this package installs
 * nothing permanent, so `pliscelle-mcp` alone is not a command anyone can
 * run. A usage screen that lists commands the reader cannot type is worse
 * than no usage screen, since it reads as authoritative.
 */
export const USAGE = `Usage:
  ${CLI_INVOCATION}                                   Start the MCP server on stdio (what an agentic host launches)
  ${CLI_INVOCATION} pair --code <PAIRING_CODE> [--name <DEVICE_NAME>] [--no-login]
                                                   Register this device, then sign it in (obtain a code from the AIScelle tab in your Pli Scelle account).
                                                   --no-login stops after registration, for a script or a browserless machine.
  ${CLI_INVOCATION} login [--device]                  Authenticate this device (browser flow by default, --device for a browserless machine)
  ${CLI_INVOCATION} ratify --list                     List correspondents not yet trusted on this device
  ${CLI_INVOCATION} ratify --sender-id <ID> [--yes]   Ratify one correspondent on this device (never callable by an agent)
  ${CLI_INVOCATION} policy --status                   Show whether the local anti-injection policy is enabled
  ${CLI_INVOCATION} policy --enable|--disable         Turn the local anti-injection policy on or off (never callable by an agent)
`

export function printUsageAndExit(message?: string): never {
	if (message) console.error(message)
	console.error(USAGE)
	process.exit(1)
}
