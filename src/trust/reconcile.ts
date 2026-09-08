/**
 * On every heartbeat, this device confronts its local list against the
 * server's current state and purges any entry that became inactive or
 * disappeared. Called by `server/heartbeat.ts` right after every
 * successful heartbeat POST, so revocation propagation is bounded by the
 * heartbeat interval: at the latest by the next heartbeat, with a
 * measurable delay.
 *
 * Also called once by `tools/senders.ts` (see that file) so a device that
 * has never yet completed a heartbeat cycle -- freshly installed, `serve`
 * just started -- can still ratify a sender without waiting for the first
 * interval to elapse.
 */
import { fetchAllSenders } from '../api/mailbox-client.js'
import { readAllowlist, reconcileAllowlistWithServer } from './allowlist-store.js'

/** Returns how many local entries were dropped, for `server/heartbeat.ts`'s local logging, which is what lets the revocation-propagation delay be measured. */
export async function reconcileLocalAllowlistWithServer(): Promise<{ purgedCount: number }> {
	const before = await readAllowlist()
	const serverSenders = await fetchAllSenders()
	await reconcileAllowlistWithServer(serverSenders)
	const after = await readAllowlist()
	return { purgedCount: Math.max(0, before.length - after.length) }
}
