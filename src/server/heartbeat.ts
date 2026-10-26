/**
 * Periodic presence signal. On every heartbeat, this device confronts its
 * local list against the server's current state and purges any entry
 * that became inactive or disappeared. Started once from
 * `transport/stdio.ts` after the MCP transport connects, stopped on
 * shutdown.
 *
 * `HEARTBEAT_INTERVAL_MS` is a default isolated in this single constant,
 * calibrated against the server's own freshness window for a device's
 * presence (5 minutes, itself a default the server side may still
 * revise): a device must beat comfortably more often than that freshness
 * window, or the server's "no agent is awake, so the notification goes to
 * the human" immediate-notification branch would misfire even while a
 * device IS actually running. One minute leaves a wide margin. Revisable
 * without touching anything else in this file if the server-side
 * freshness window changes.
 *
 * `policyEnabled` reports this device's local kill switch (policy/policy-
 * toggle.ts) as it actually stands at each beat: the switch is reported
 * to the server and logged server-side at every heartbeat; otherwise it
 * is only turned off once, locally, without a trace. The server-side
 * logging this requires is the server's own responsibility, out of this
 * package's reach; this file's job ends at reporting the true value
 * honestly on every beat, never a cached or hardcoded one, so a toggle
 * flipped between two heartbeats is never silently under-reported.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { sendHeartbeat } from '../api/mailbox-client.js'
import { isPolicyEnabled } from '../policy/policy-toggle.js'
import { readAllowlist } from '../trust/allowlist-store.js'
import { reconcileLocalAllowlistWithServer } from '../trust/reconcile.js'
import { logAgentMailboxEvent } from './logging.js'

export const HEARTBEAT_INTERVAL_MS = 60_000

async function beatOnce(server: McpServer): Promise<void> {
	try {
		const [policyEnabled, ratified] = await Promise.all([isPolicyEnabled(), readAllowlist()])
		await sendHeartbeat({
			policyEnabled,
			ratifiedSenderIds: ratified.filter((entry) => entry.ratifiedLocally).map((entry) => entry.serverSenderId),
		})

		const { purgedCount } = await reconcileLocalAllowlistWithServer()
		if (purgedCount > 0) {
			logAgentMailboxEvent(server, { event: 'allowlist_reconciled', purgedCount })
		}
	} catch (error) {
		logAgentMailboxEvent(server, {
			event: 'heartbeat_failed',
			reason: error instanceof Error ? error.message : String(error),
		})
	}
}

export interface HeartbeatHandle {
	stop: () => void
}

export function startHeartbeat(server: McpServer): HeartbeatHandle {
	void beatOnce(server) // Fire immediately, do not wait a full interval before the first reconciliation.
	const timer = setInterval(() => void beatOnce(server), HEARTBEAT_INTERVAL_MS)
	timer.unref() // Never keeps the process alive on its own; shutdown is driven by the transport/signal handlers in transport/stdio.ts.
	return { stop: () => clearInterval(timer) }
}
