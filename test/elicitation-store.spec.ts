import { mkdtemp, rm } from 'node:fs/promises'
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
})
