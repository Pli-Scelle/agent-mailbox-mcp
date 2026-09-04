/**
 * Composition point for the six AIScelle tools plus the sensitive-content
 * resource, onto the `McpServer` `create-server.ts` returns. That file's
 * own doc comment names this the piece deliberately left for this module:
 * the tools, and the `resources` capability they need, register onto the
 * `McpServer` it returns. Called once from `transport/stdio.ts`, before
 * `server.connect`.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { registerSensitiveMessageResource } from '../resources/sensitive-message-resource.js'
import { registerInboxTool } from '../tools/inbox.js'
import { registerPurgeTool } from '../tools/purge.js'
import { registerReadTool } from '../tools/read.js'
import { registerSearchTool } from '../tools/search.js'
import { registerSendTool } from '../tools/send.js'
import { registerSendersTool } from '../tools/senders.js'

export function registerAgentMailboxTools(server: McpServer): void {
	registerInboxTool(server)
	registerSearchTool(server)
	registerReadTool(server)
	registerSendersTool(server)
	registerSendTool(server)
	registerPurgeTool(server)
	registerSensitiveMessageResource(server)
}
