/**
 * Persisted elicitation state: this connector writes the current
 * conversation's elicitation state to disk. The MCP process is restarted
 * by many clients between two turns, while the content already read stays
 * in the model's own context; an in-memory flag would not survive that
 * restart, so this state is persisted to disk with an expiration. This
 * file is what does.
 *
 * One record per conversation id (elicitation/conversation-id.ts), tracking
 * a single fact: has a `read` happened in this conversation, recently
 * enough that the record has not expired. `elicitation-gate.ts` is the only
 * caller allowed to turn that fact into a decision; this module only
 * stores and retrieves it.
 *
 * The record's `hasRead` flag is one-directional by construction: once a
 * `read` sets it, nothing in this module ever flips it back to `false`
 * while the record is still valid (`touchConversation` below preserves it
 * explicitly). Staleness must never read as safety: an expiration does not
 * prove no read took place, it only proves the record no longer knows. If
 * this store let some other tool call quietly downgrade a `true` back to
 * `false`, an agent could launder a real prior read through an innocuous call
 * (`inbox`, `senders`) and land back on the frictionless path this file
 * exists to close off. The only way a conversation's record ever starts at
 * `false` is that no record for it existed yet at all.
 */
import { join } from 'node:path'
import { z } from 'zod'
import { readJsonState, writeJsonState } from '../config/local-store.js'
import { resolveConfigDir } from '../config/paths.js'

/**
 * Not derived from a spec value; this record's own lifetime is a
 * deliberate implementation choice, distinct from message
 * `default_ttl_hours` or the pairing code's TTL. Chosen to cover a
 * realistic single working session with an agentic host without forcing a
 * needless re-elicitation partway through one; declared as a named
 * constant isolated in this one value, revisable independently of the
 * rest of the module if a different figure turns out to fit better.
 */
const ELICITATION_RECORD_TTL_HOURS = 24

const conversationRecordSchema = z.object({
	conversationId: z.string().min(1),
	hasRead: z.boolean(),
	updatedAt: z.string().datetime(),
	expiresAt: z.string().datetime(),
})
type ConversationRecord = z.infer<typeof conversationRecordSchema>

const elicitationStateFileSchema = z.object({
	conversations: z.array(conversationRecordSchema),
})
type ElicitationStateFile = z.infer<typeof elicitationStateFileSchema>

function elicitationStatePath(): string {
	return join(resolveConfigDir(), 'elicitation-state.json')
}

async function readState(): Promise<ElicitationStateFile> {
	const state = await readJsonState(elicitationStatePath(), elicitationStateFileSchema)
	return state ?? { conversations: [] }
}

async function writeState(state: ElicitationStateFile): Promise<void> {
	await writeJsonState(elicitationStatePath(), state)
}

function isExpired(record: ConversationRecord, now: Date): boolean {
	return new Date(record.expiresAt).getTime() <= now.getTime()
}

export type ConversationLookup = { status: 'no_record' } | { status: 'known'; hasRead: boolean }

/**
 * `elicitation-gate.ts`'s only read path. The safe-default cases collapse
 * into a single `no_record` bucket here deliberately: a genuinely absent
 * record and an expired one must produce the exact same downstream
 * decision (elicit), and folding them into one return shape makes it
 * structurally impossible for a caller to accidentally special-case the
 * expired branch back into "safe" -- see this module's doc comment.
 */
export async function lookupConversationState(
	conversationId: string,
	now: Date = new Date(),
): Promise<ConversationLookup> {
	const state = await readState()
	const record = state.conversations.find((entry) => entry.conversationId === conversationId)
	if (!record || isExpired(record, now)) return { status: 'no_record' }
	return { status: 'known', hasRead: record.hasRead }
}

/**
 * Writes (creating or replacing) the record for one conversation id, always
 * refreshing `expiresAt` from `now`. Internal: every external caller goes
 * through `markConversationRead` or `touchConversationAfterAllowedAction`
 * below, never through this directly, so the one-directional rule in this
 * module's doc comment has exactly two enforced entry points.
 */
async function upsertRecord(conversationId: string, hasRead: boolean, now: Date): Promise<void> {
	const state = await readState()
	const expiresAt = new Date(now.getTime() + ELICITATION_RECORD_TTL_HOURS * 60 * 60 * 1000)
	const withoutExisting = state.conversations.filter((entry) => entry.conversationId !== conversationId)
	withoutExisting.push({
		conversationId,
		hasRead,
		updatedAt: now.toISOString(),
		expiresAt: expiresAt.toISOString(),
	})
	await writeState({ conversations: withoutExisting })
}

/**
 * `tools/read.ts`'s write path, called once a message has actually been
 * decrypted and verified (never on a rejected message: nothing was
 * exposed, so nothing was read). Sticky by construction (see doc comment):
 * always writes `true`, regardless of what was there before.
 */
export async function markConversationRead(conversationId: string, now: Date = new Date()): Promise<void> {
	await upsertRecord(conversationId, true, now)
}

/**
 * Called by every one of the six tools after a call this device allowed to
 * complete (inbox/search/senders read only headers or the local mirror
 * and carry no risk of their own, but touching here too means
 * a conversation that starts with `inbox` -- the ordinary first call of a
 * session -- already has an established, frictionless baseline by the time
 * `send` might be called later with nothing ever read). Preserves an
 * existing `true` (see doc comment); a brand new conversation id, or one
 * whose only prior record already read `false`, is written as `false`.
 *
 * Reads the RAW stored record, ignoring expiry: an expired `true` record
 * must still read as `true` here, never silently reset to `false` by the
 * passage of time. Distinct from `lookupConversationState`, which folds
 * expiry into `no_record` for the GATE's decision -- that fold must never
 * leak into what this function preserves when refreshing the file.
 */
export async function touchConversationAfterAllowedAction(
	conversationId: string,
	now: Date = new Date(),
): Promise<void> {
	const state = await readState()
	const existing = state.conversations.find((entry) => entry.conversationId === conversationId)
	await upsertRecord(conversationId, existing?.hasRead ?? false, now)
}
