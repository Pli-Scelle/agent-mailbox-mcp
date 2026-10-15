import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as localStore from '../src/config/local-store.js'
import {
	lookupConversationState,
	markConversationRead,
	touchConversationAfterAllowedAction,
} from '../src/elicitation/elicitation-store.js'

vi.mock('../src/config/local-store.js', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../src/config/local-store.js')>()
	return { ...actual, writeJsonState: vi.fn(actual.writeJsonState) }
})

const actualStore = await vi.importActual<typeof import('../src/config/local-store.js')>('../src/config/local-store.js')

/**
 * Issue #1938: a `touch` that read `hasRead: false` and a concurrent `read` on the same
 * conversation must never end on `false`. The touch is held between its read and its write
 * while the read runs; whatever the read managed to do meanwhile, the final record says true.
 */
describe('elicitation-store under concurrent writes', () => {
	let dir: string
	let previousXdgConfigHome: string | undefined

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), 'aiscelle-mcp-elicitation-race-'))
		previousXdgConfigHome = process.env.XDG_CONFIG_HOME
		process.env.XDG_CONFIG_HOME = dir
	})

	afterEach(async () => {
		vi.mocked(localStore.writeJsonState).mockReset()
		vi.mocked(localStore.writeJsonState).mockImplementation(actualStore.writeJsonState)
		if (previousXdgConfigHome === undefined) delete process.env.XDG_CONFIG_HOME
		else process.env.XDG_CONFIG_HOME = previousXdgConfigHome
		await rm(dir, { recursive: true, force: true })
	})

	it('a touch that read false cannot overwrite a concurrent read back to false', async () => {
		await touchConversationAfterAllowedAction('conversation-1')

		let signalHeld!: () => void
		let release!: () => void
		const held = new Promise<void>((resolve) => (signalHeld = resolve))
		const released = new Promise<void>((resolve) => (release = resolve))
		vi.mocked(localStore.writeJsonState).mockImplementationOnce(async (path, value) => {
			signalHeld()
			await released
			return actualStore.writeJsonState(path, value)
		})

		const touch = touchConversationAfterAllowedAction('conversation-1')
		await held
		const read = markConversationRead('conversation-1')
		await new Promise((resolve) => setTimeout(resolve, 150))
		release()
		await Promise.all([touch, read])

		expect(await lookupConversationState('conversation-1')).toEqual({ status: 'known', hasRead: true })
	})

	it('two conversations written at once both keep their record', async () => {
		await Promise.all([
			markConversationRead('conversation-a'),
			touchConversationAfterAllowedAction('conversation-b'),
			markConversationRead('conversation-c'),
		])

		expect(await lookupConversationState('conversation-a')).toEqual({ status: 'known', hasRead: true })
		expect(await lookupConversationState('conversation-b')).toEqual({ status: 'known', hasRead: false })
		expect(await lookupConversationState('conversation-c')).toEqual({ status: 'known', hasRead: true })
	})
})
