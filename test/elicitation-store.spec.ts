import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
	lookupConversationState,
	markConversationRead,
	touchConversationAfterAllowedAction,
} from '../src/elicitation/elicitation-store.js'

describe('elicitation-store', () => {
	let dir: string
	let previousXdgConfigHome: string | undefined

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), 'aiscelle-mcp-elicitation-test-'))
		previousXdgConfigHome = process.env.XDG_CONFIG_HOME
		process.env.XDG_CONFIG_HOME = dir
	})

	afterEach(async () => {
		if (previousXdgConfigHome === undefined) delete process.env.XDG_CONFIG_HOME
		else process.env.XDG_CONFIG_HOME = previousXdgConfigHome
		await rm(dir, { recursive: true, force: true })
	})

	it('reports no_record for a conversation id never seen before', async () => {
		expect(await lookupConversationState('unseen')).toEqual({ status: 'no_record' })
	})

	it('reports hasRead: true right after markConversationRead', async () => {
		await markConversationRead('conversation-a')
		expect(await lookupConversationState('conversation-a')).toEqual({ status: 'known', hasRead: true })
	})

	it('establishes a false baseline on the first touch of a brand new conversation', async () => {
		await touchConversationAfterAllowedAction('conversation-b')
		expect(await lookupConversationState('conversation-b')).toEqual({ status: 'known', hasRead: false })
	})

	it('never downgrades hasRead back to false on a later touch (sticky, one-directional by design)', async () => {
		await markConversationRead('conversation-c')
		await touchConversationAfterAllowedAction('conversation-c')
		expect(await lookupConversationState('conversation-c')).toEqual({ status: 'known', hasRead: true })
	})

	it('a different conversation id is tracked independently', async () => {
		await markConversationRead('read-conversation')
		expect(await lookupConversationState('other-conversation')).toEqual({ status: 'no_record' })
	})

	it('treats an expired record as no_record, never as proof of no read', async () => {
		const readAt = new Date('2026-01-01T00:00:00.000Z')
		await markConversationRead('conversation-d', readAt)

		const wellAfterExpiry = new Date('2026-02-01T00:00:00.000Z')
		expect(await lookupConversationState('conversation-d', wellAfterExpiry)).toEqual({ status: 'no_record' })
	})

	it('treats an expired FALSE record as no_record too, not as a still-valid clean baseline', async () => {
		const touchedAt = new Date('2026-01-01T00:00:00.000Z')
		await touchConversationAfterAllowedAction('conversation-e', touchedAt)

		const wellAfterExpiry = new Date('2026-02-01T00:00:00.000Z')
		expect(await lookupConversationState('conversation-e', wellAfterExpiry)).toEqual({ status: 'no_record' })
	})

	it('touching after an expired true record still preserves true, never resets from staleness alone', async () => {
		const readAt = new Date('2026-01-01T00:00:00.000Z')
		await markConversationRead('conversation-f', readAt)

		const wellAfterExpiry = new Date('2026-02-01T00:00:00.000Z')
		await touchConversationAfterAllowedAction('conversation-f', wellAfterExpiry)

		expect(await lookupConversationState('conversation-f', wellAfterExpiry)).toEqual({
			status: 'known',
			hasRead: true,
		})
	})

	async function storedConversationIds(): Promise<Array<string>> {
		const raw = await readFile(join(dir, 'pliscelle-mcp', 'elicitation-state.json'), 'utf8')
		return (JSON.parse(raw) as { conversations: Array<{ conversationId: string }> }).conversations.map(
			(entry) => entry.conversationId,
		)
	}

	it('drops a record expired more than 24 hours ago from the file on a write (issue #2069)', async () => {
		await markConversationRead('stale-conversation', new Date('2026-01-01T00:00:00.000Z'))
		expect(await storedConversationIds()).toEqual(['stale-conversation'])

		// The stale record expired on 2026-01-02T00:00Z, so 25 hours past that is purgeable.
		await touchConversationAfterAllowedAction('fresh-conversation', new Date('2026-01-03T01:00:00.000Z'))

		expect(await storedConversationIds()).toEqual(['fresh-conversation'])
	})

	it('keeps a record that expired less than 24 hours ago, and one still valid, on a write', async () => {
		await markConversationRead('recently-expired', new Date('2026-01-01T00:00:00.000Z'))
		await markConversationRead('still-valid', new Date('2026-01-02T00:00:00.000Z'))

		// recently-expired expired on 2026-01-02T00:00Z, 23 hours before this write.
		await touchConversationAfterAllowedAction('writer', new Date('2026-01-02T23:00:00.000Z'))

		expect((await storedConversationIds()).sort()).toEqual(['recently-expired', 'still-valid', 'writer'])
	})
})
