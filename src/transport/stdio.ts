/**
 * Entry point for `pliscelle-mcp` run with no subcommand (cli/serve.ts):
 * the form an agentic host actually launches, run as a subprocess that
 * talks to it over its own standard input/output streams.
 *
 * Standard input/output is the JSON-RPC channel `StdioServerTransport`
 * owns end to end: nothing in this module, or anything it calls before
 * `transport.connect`, may write to stdout. Every diagnostic here goes to
 * stderr, which the SDK's stdio transport (and every agentic host's own
 * subprocess handling) leaves free for exactly this.
 *
 * Session validity is checked, and the mailbox link confirmed, AFTER the
 * transport connects, not before (issue #984: an unpaired device or a
 * definitively lost session used to fail this function outright, which an
 * MCP client only ever sees as a bare "Connection closed", naming neither
 * the cause nor the fix). A server whose tools are unusable is still more
 * useful than no server at all to an unattended agent: this device's
 * `access_status` tool (tools/access-status.ts) and every other tool's own
 * explicit failure (through `ensureValidSession`, oauth/ensure-valid-
 * session.ts, called again on every `api/mailbox-client.ts` request) are
 * what carry the clean-refusal doctrine now, one tool call at a time,
 * instead of the whole process refusing to start.
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js'
import type { RuntimeOptions } from '../config/unattended-mode.js'
import { ensureMailboxLinked } from '../crypto/ensure-mailbox-linked.js'
import { ensureValidSession } from '../oauth/ensure-valid-session.js'
import { createAgentMailboxServer } from '../server/create-server.js'
import { startHeartbeat } from '../server/heartbeat.js'
import { logAgentMailboxEvent } from '../server/logging.js'
import { registerAgentMailboxTools } from '../server/register-agent-mailbox-tools.js'
import { getPackageVersion } from '../version/package-version.js'

export async function runStdioServer(options: RuntimeOptions): Promise<void> {
	const server = createAgentMailboxServer()
	registerAgentMailboxTools(server, options)

	const transport = new StdioServerTransport()
	await server.connect(transport)

	logAgentMailboxEvent(server, {
		event: 'server_started',
		packageVersion: getPackageVersion(),
		protocolVersion: LATEST_PROTOCOL_VERSION,
		// Logged at startup so the mode actually in force is readable from the
		// host's own diagnostics, never inferred from what a configuration file
		// was believed to say.
		unattended: options.unattended,
	})

	try {
		const session = await ensureValidSession()
		// Makes this device's mailbox exist (or confirms its key still
		// matches) before any tool call actually needs it. See crypto/ensure-
		// mailbox-linked.ts's doc comment for the backend gap this depends on.
		await ensureMailboxLinked()
		logAgentMailboxEvent(server, { event: 'session_authenticated', deviceId: session.clientId })
	} catch (error) {
		logAgentMailboxEvent(server, {
			event: 'session_authentication_failed',
			reason: error instanceof Error ? error.message : String(error),
		})
	}

	const heartbeat = startHeartbeat(server)

	const shutdown = async (): Promise<void> => {
		heartbeat.stop()
		await server.close()
		process.exit(0)
	}
	process.once('SIGINT', () => void shutdown())
	process.once('SIGTERM', () => void shutdown())
}
