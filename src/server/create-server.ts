/**
 * Builds this connector's MCP server shell: identity, protocol
 * capabilities, nothing else. No tool is registered here -- the six
 * AIScelle tools, and the `resources` capability their sensitive-content
 * resource links need, are implemented and registered onto the
 * `McpServer` this function returns by
 * `server/register-agent-mailbox-tools.ts`, which composes tool families
 * onto one server instance.
 *
 * `capabilities: { logging: {} }` is the one capability this package's
 * own code uses (server/logging.ts). Declaring `tools: {}` before any
 * tool exists would advertise a capability with nothing behind it;
 * `McpServer.registerTool` (SDK-verified) adds it to the capability set
 * itself the moment the first tool is registered, so nothing here needs
 * to change to turn it on.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { getPackageVersion } from '../version/package-version.js'

export function createAgentMailboxServer(): McpServer {
	return new McpServer(
		{ name: 'pliscelle-agent-mailbox', version: getPackageVersion() },
		{ capabilities: { logging: {} } },
	)
}
