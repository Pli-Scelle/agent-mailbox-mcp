/**
 * This device's local, ratified allowlist trace. This local trace is what
 * governs trust at read time, never the mirrored server-reported state.
 *
 * This store mirrors EVERY sender the server has told this device about
 * (ratified or not), because `trust/resolve-trust.ts` must be able to try
 * a non-ratified sender's key too, to tell "no key verifies at all, so
 * the message is rejected" apart from "a key verifies but that sender is
 * not ratified here, so its messages are treated as data whatever trust
 * level the server reports". Only
 * `ratifiedLocally`/`ratifiedLocallyAt` are ever written by this device
 * itself (trust/ratify.ts, the human-run command); every other field is a
 * local mirror of what `GET /agent-mailbox/senders` last reported, kept in
 * sync by `trust/reconcile.ts` at each heartbeat.
 */
import { join } from 'node:path'
import { z } from 'zod'
import { readJsonState, writeJsonState } from '../config/local-store.js'
import { resolveConfigDir } from '../config/paths.js'

const localSenderRecordSchema = z.object({
	serverSenderId: z.string().min(1),
	address: z.string().min(1),
	publicKeyEd25519: z.string().min(1),
	/** Mirrors the server's configured level; meaningless unless `ratifiedLocally` is true. */
	trustLevel: z.enum(['data', 'instruction']),
	label: z.string(),
	isActiveOnServer: z.boolean(),
	ratifiedLocally: z.boolean(),
	ratifiedLocallyAt: z.string().datetime().nullable(),
})
export type LocalSenderRecord = z.infer<typeof localSenderRecordSchema>

const allowlistFileSchema = z.object({
	entries: z.array(localSenderRecordSchema),
})

function allowlistPath(): string {
	return join(resolveConfigDir(), 'allowlist.json')
}

export async function readAllowlist(): Promise<Array<LocalSenderRecord>> {
	const state = await readJsonState(allowlistPath(), allowlistFileSchema)
	return state?.entries ?? []
}

async function writeAllowlist(entries: Array<LocalSenderRecord>): Promise<void> {
	await writeJsonState(allowlistPath(), { entries } satisfies z.infer<typeof allowlistFileSchema>)
}

/**
 * Merges the server's current sender list into the local mirror. On every
 * heartbeat, this device confronts its local list against the server's
 * current state and purges any entry that became inactive or disappeared.
 * Called by `trust/reconcile.ts` after every heartbeat. Behaviour, entry
 * by entry:
 *
 *   - Present on the server, active, SAME public key as the local mirror
 *     (or no local entry at all yet): local mirror fields refreshed
 *     (label/trustLevel may have changed server-side); this device's own
 *     `ratifiedLocally` state is NEVER touched by this function in that
 *     case, only by `trust/ratify.ts`.
 *   - Present on the server, active, but under a DIFFERENT public key than
 *     the local mirror already holds for this same server sender id:
 *     treated as a brand-new, unratified entry, `ratifiedLocally` reset to
 *     `false` regardless of what the previous key's ratification state
 *     was. This closes a specific attack rather than merely describing
 *     it: a compromised server cannot swap the key behind an id this
 *     device already ratified and inherit that ratification for a new key
 *     it controls. Ratification binds the PAIR (server sender id, public
 *     key), never the id alone.
 *   - Present on the server, `isActive: false`, OR absent from the
 *     server's current active set entirely (deleted): the local entry is
 *     DROPPED outright, `ratifiedLocally` included. A disabled or deleted
 *     server-side entry must stop being trusted locally. Dropping rather
 *     than merely flipping `isActiveOnServer` to false is deliberate: a
 *     stale record kept around a moment longer than necessary is exactly
 *     the residual risk of a revoked correspondent staying trusted at
 *     instruction level indefinitely, and there is nothing this device
 *     legitimately still needs a dropped entry FOR (a message already
 *     read keeps whatever trust it resolved to at read time; this store
 *     is not a message-history log).
 *   - Local-only (a previous ratification for a sender the server no
 *     longer lists at all, e.g. deleted between two heartbeats): also
 *     dropped, same reasoning, since it cannot appear in `activeServerIds`
 *     either.
 */
export function reconcileAllowlistEntries(
	localEntries: ReadonlyArray<LocalSenderRecord>,
	serverEntries: ReadonlyArray<{
		id: string
		senderAddress: string
		senderPublicKeyEd25519: string
		trustLevel: 'data' | 'instruction'
		label: string
		isActive: boolean
	}>,
): Array<LocalSenderRecord> {
	const localById = new Map(localEntries.map((entry) => [entry.serverSenderId, entry]))
	const merged: Array<LocalSenderRecord> = []

	for (const serverEntry of serverEntries) {
		if (!serverEntry.isActive) continue // Dropped: see doc comment above.
		const local = localById.get(serverEntry.id)
		// Ratification is only ever valid for the key it was granted to. A
		// server reporting a different key under an id this device already
		// ratified must never inherit that ratification -- see the doc
		// comment above for the exact attack this closes.
		const keyUnchanged = local !== undefined && local.publicKeyEd25519 === serverEntry.senderPublicKeyEd25519
		merged.push({
			serverSenderId: serverEntry.id,
			address: serverEntry.senderAddress,
			publicKeyEd25519: serverEntry.senderPublicKeyEd25519,
			trustLevel: serverEntry.trustLevel,
			label: serverEntry.label,
			isActiveOnServer: true,
			ratifiedLocally: keyUnchanged ? (local?.ratifiedLocally ?? false) : false,
			ratifiedLocallyAt: keyUnchanged ? (local?.ratifiedLocallyAt ?? null) : null,
		})
	}

	return merged
}

export async function reconcileAllowlistWithServer(
	serverEntries: ReadonlyArray<{
		id: string
		senderAddress: string
		senderPublicKeyEd25519: string
		trustLevel: 'data' | 'instruction'
		label: string
		isActive: boolean
	}>,
): Promise<void> {
	const local = await readAllowlist()
	await writeAllowlist(reconcileAllowlistEntries(local, serverEntries))
}

/**
 * `trust/ratify.ts`'s write path. Refuses a key already present in the
 * local mirror under a DIFFERENT server sender id: the ratification
 * command refuses an entry whose key is already present under another
 * label. This is the local-store half of that guard; the server
 * enforces the same uniqueness independently, on its own side.
 * Returns the updated record, or throws `DuplicateAllowlistKeyError`.
 */
export class DuplicateAllowlistKeyError extends Error {
	constructor(public readonly existingLabel: string) {
		super(
			`This public key is already ratified locally under the label "${existingLabel}". Ratifying it again under a different label would let a same-key duplicate silently gain trust; remove or rename the existing entry first if this is intentional.`,
		)
		this.name = 'DuplicateAllowlistKeyError'
	}
}

export async function markRatifiedLocally(
	serverSenderId: string,
	ratifiedAt: Date = new Date(),
): Promise<LocalSenderRecord> {
	const entries = await readAllowlist()
	const target = entries.find((entry) => entry.serverSenderId === serverSenderId)
	if (!target) {
		throw new Error(
			`No sender with server id ${serverSenderId} is known locally. Run the senders list first (this device syncs its mirror from the server at each heartbeat and before ratifying).`,
		)
	}

	const duplicate = entries.find(
		(entry) => entry.serverSenderId !== serverSenderId && entry.publicKeyEd25519 === target.publicKeyEd25519,
	)
	if (duplicate) {
		throw new DuplicateAllowlistKeyError(duplicate.label)
	}

	target.ratifiedLocally = true
	target.ratifiedLocallyAt = ratifiedAt.toISOString()
	await writeAllowlist(entries)
	return target
}
