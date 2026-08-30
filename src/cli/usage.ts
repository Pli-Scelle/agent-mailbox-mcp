export const USAGE = `Usage:
  pliscelle-mcp                                   Start the MCP server on stdio (what an agentic host launches)
  pliscelle-mcp pair --code <PAIRING_CODE> [--name <DEVICE_NAME>]
                                                   Register this device (obtain a code from the AIScelle tab in your Pli Scelle account)
  pliscelle-mcp login [--device]                  Authenticate this device (browser flow by default, --device for a browserless machine)
  pliscelle-mcp ratify --list                     List correspondents not yet trusted on this device
  pliscelle-mcp ratify --sender-id <ID> [--yes]   Ratify one correspondent on this device (never callable by an agent)
  pliscelle-mcp policy --status                   Show whether the local anti-injection policy is enabled
  pliscelle-mcp policy --enable|--disable         Turn the local anti-injection policy on or off (never callable by an agent)
`

export function printUsageAndExit(message?: string): never {
	if (message) console.error(message)
	console.error(USAGE)
	process.exit(1)
}
