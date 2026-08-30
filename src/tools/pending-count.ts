/**
 * Every tool response ends with the number of messages still waiting, and
 * that is deliberately not optional on any of them. Zero, and the agent
 * moves on; three, and it knows it has to list them. It costs a few tokens
 * per call and removes any need for the agent to poll. Every one of the six
 * tools
 * (tools/inbox.ts through tools/purge.ts) wraps its final structured
 * result through `appendPendingCount` so a caller cannot ship a tool that
 * forgets it.
 */
import { fetchPendingCount } from '../api/mailbox-client.js'

export interface WithPendingCount {
	pendingMessageCount: number
}

export async function appendPendingCount<T extends Record<string, unknown>>(result: T): Promise<T & WithPendingCount> {
	const pendingMessageCount = await fetchPendingCount()
	return { ...result, pendingMessageCount }
}
