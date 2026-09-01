/**
 * Every tool response ends with what is still waiting for a human, and that
 * is deliberately not optional on any of them. Zero, and the agent moves on;
 * three, and it knows it has to say so. It costs a few tokens per call and
 * removes any need for the agent to poll. Every one of the six tools
 * (tools/inbox.ts through tools/purge.ts) wraps its final structured result
 * through `appendPendingCount` so a caller cannot ship a tool that forgets
 * it.
 *
 * Two counts ride along, for the same reason. Messages waiting to be read,
 * and correspondents waiting to be ratified: a correspondent authorized in
 * the tab but never ratified here cannot write, and nothing else in the
 * product tells its owner (issue #959). The agent is the one surface the
 * owner is already looking at.
 */
import { fetchPendingCount } from '../api/mailbox-client.js'
import { readAllowlist } from '../trust/allowlist-store.js'

export interface WithPendingCount {
	pendingMessageCount: number
	pendingRatificationCount: number
}

/**
 * Correspondents this device knows about but has not ratified yet.
 *
 * Read from the local file, never from the server: the whole point of
 * ratification is that what this device believes does not come from there
 * (spec section 5.3). Costs no round trip, which is why it can ride along
 * on every tool call like the message count does.
 */
async function countPendingRatifications(): Promise<number> {
	const entries = await readAllowlist()
	return entries.filter((entry) => !entry.ratifiedLocally).length
}

export async function appendPendingCount<T extends Record<string, unknown>>(result: T): Promise<T & WithPendingCount> {
	const [pendingMessageCount, pendingRatificationCount] = await Promise.all([
		fetchPendingCount(),
		countPendingRatifications(),
	])
	return { ...result, pendingMessageCount, pendingRatificationCount }
}
