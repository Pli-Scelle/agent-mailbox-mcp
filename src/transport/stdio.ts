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
 * Session validity is checked and, if needed, refreshed BEFORE the
 * transport ever connects (`ensureValidSession`, oauth/ensure-valid-
 * session.ts): an unpaired device or an expired session with no refresh
 * token left has nothing useful to offer once later tools exist, and a
 * clean-refusal doctrine -- fail loudly, with an actionable message
 * saying what to do -- applies here by the same reasoning it applies to
 * a rejected package version, before pretending to be a working server.
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js'
import { ensureMailboxLinked } from '../crypto/ensure-mailbox-linked.js'
import { ensureValidSession } from '../oauth/ensure-valid-session.js'
import { createAgentMailboxServer } from '../server/create-server.js'
import { startHeartbeat } from '../server/heartbeat.js'
import { logAgentMailboxEvent } from '../server/logging.js'
import { registerAgentMailboxTools } from '../server/register-agent-mailbox-tools.js'
import { getPackageVersion } from '../version/package-version.js'

export async function runStdioServer(): Promise<void> {
	const session = await ensureValidSession()
	// Makes this device's mailbox exist (or confirms its key still
	// matches) before any tool below can act on it. See crypto/ensure-
	// mailbox-linked.ts's doc comment for the backend gap this depends on.
	await ensureMailboxLinked()

	const server = createAgentMailboxServer()
	registerAgentMailboxTools(server)

	const transport = new StdioServerTransport()
	await server.connect(transport)

	logAgentMailboxEvent(server, {
		event: 'server_started',
		packageVersion: getPackageVersion(),
		protocolVersion: LATEST_PROTOCOL_VERSION,
	})
	logAgentMailboxEvent(server, { event: 'session_authenticated', deviceId: session.clientId })

	const heartbeat = startHeartbeat(server)

	const shutdown = async (): Promise<void> => {
		heartbeat.stop()
		await server.close()
		process.exit(0)
	}
	process.once('SIGINT', () => void shutdown())
	process.once('SIGTERM', () => void shutdown())
}
