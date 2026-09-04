/**
 * Logging is a negotiable protocol capability: the local log goes through
 * it, accepting that it transits through the client. No logging
 * notification carries decrypted content, a title, or a body excerpt. The
 * client (the agentic host) is third-party software this connector does
 * not control and cannot audit; a title or body sent down this channel
 * could land in an ordinary, uninventoried log file on the user's disk.
 * So this module's event vocabulary is closed by construction: every case
 * below is a `{ level, data }` shape carrying only identifiers, timestamps
 * and machine-readable reasons, and the type system, not a runtime check,
 * is what prevents a future call site from slipping a decrypted string in
 * as `data`.
 *
 * Scoped to exactly what this package's code can actually produce:
 * connection lifecycle and the OAuth/version-negotiation outcomes above
 * it. Code that adds the six tools, the crypto, or the elicitation store
 * extends `AgentMailboxLogEvent` with its own cases the same way the
 * server side already does for its own journal -- never by writing
 * free-form strings through this function.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

export type AgentMailboxLogEvent =
	| { event: 'server_started'; packageVersion: string; protocolVersion: string }
	| { event: 'session_authenticated'; deviceId: string }
	| { event: 'session_authentication_failed'; reason: string }
	| { event: 'token_refreshed'; deviceId: string }
	| { event: 'token_refresh_failed'; deviceId: string; reason: string }
	| { event: 'package_version_rejected'; reason: 'too_old' | 'blocked'; minVersion: string | undefined }
	| { event: 'message_rejected'; messageId: string }
	| { event: 'allowlist_reconciled'; purgedCount: number }
	| { event: 'heartbeat_failed'; reason: string }
	| { event: 'elicitation_refused_no_capability'; tool: 'send' | 'purge' }
	| { event: 'elicitation_request_failed'; tool: 'send' | 'purge' }
	| { event: 'elicitation_declined'; tool: 'send' | 'purge'; action: 'decline' | 'cancel' }
	| { event: 'elicitation_granted'; tool: 'send' | 'purge' }

const EVENT_LOG_LEVEL: Record<AgentMailboxLogEvent['event'], 'info' | 'warning' | 'error'> = {
	server_started: 'info',
	session_authenticated: 'info',
	session_authentication_failed: 'error',
	token_refreshed: 'info',
	token_refresh_failed: 'error',
	package_version_rejected: 'error',
	message_rejected: 'warning',
	allowlist_reconciled: 'info',
	heartbeat_failed: 'warning',
	elicitation_refused_no_capability: 'warning',
	elicitation_request_failed: 'warning',
	elicitation_declined: 'warning',
	elicitation_granted: 'info',
}

const LOGGER_NAME = 'aiscelle-mcp'

/**
 * Fire-and-forget by design: a logging notification that fails to send
 * (no client connected yet, transport already tearing down) must never
 * throw back into the caller's real work. `Server.sendLoggingMessage`
 * (verified `@modelcontextprotocol/sdk@1.30.0`) already no-ops when the
 * `logging` capability was not declared or the client asked for a level
 * that filters this one out; the try/catch here only guards the
 * notification write itself.
 */
export function logAgentMailboxEvent(server: McpServer, event: AgentMailboxLogEvent): void {
	const { event: name, ...data } = event
	void server.server
		.sendLoggingMessage({
			level: EVENT_LOG_LEVEL[name],
			logger: LOGGER_NAME,
			data: { event: name, timestamp: new Date().toISOString(), ...data },
		})
		.catch(() => {
			// See docblock: never propagate a logging failure into the caller.
		})
}
