/**
 * Composition point for the seven AIScelle tools plus the sensitive-content
 * resource, onto the `McpServer` `create-server.ts` returns. That file's
 * own doc comment names this the piece deliberately left for this module:
 * the tools, and the `resources` capability they need, register onto the
 * `McpServer` it returns. Called once from `transport/stdio.ts`, before
 * `server.connect`.
 *
 * `access_status` (issue #984) is registered alongside the six mailbox
 * tools, never gated behind whether this device currently has a valid
 * session: it is the one tool an agent can always call to find out, which
 * is the whole point of it existing.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { RuntimeOptions } from '../config/unattended-mode.js'
import { registerSensitiveMessageResource } from '../resources/sensitive-message-resource.js'
import { registerAccessStatusTool } from '../tools/access-status.js'
import { registerInboxTool } from '../tools/inbox.js'
import { registerPurgeTool } from '../tools/purge.js'
import { registerReadTool } from '../tools/read.js'
import { registerSearchTool } from '../tools/search.js'
import { registerSendTool } from '../tools/send.js'
import { registerSendersTool } from '../tools/senders.js'

export function registerAgentMailboxTools(server: McpServer, options: RuntimeOptions): void {
	registerAccessStatusTool(server)
	registerInboxTool(server)
	registerSearchTool(server)
	registerReadTool(server)
	registerSendersTool(server)
	// Only the two tools that cross elicitation/elicitation-gate.ts take the
	// runtime options: the other five pass through no gate, and handing them
	// a mode they cannot act on would only blur where it actually applies.
	registerSendTool(server, options)
	registerPurgeTool(server, options)
	registerSensitiveMessageResource(server)
}
