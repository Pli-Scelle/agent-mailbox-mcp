import { randomBytes } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as mailboxClient from '../src/api/mailbox-client.js'
import * as localStore from '../src/config/local-store.js'
import { markRatifiedLocally, readAllowlist, reconcileAllowlistWithServer } from '../src/trust/allowlist-store.js'
import { RatificationAbortedError, runRatifyCommand } from '../src/trust/ratify.js'

vi.mock('../src/api/mailbox-client.js', () => ({
	fetchAllSenders: vi.fn(),
	fetchSenderPage: vi.fn(),
}))

vi.mock('../src/config/local-store.js', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../src/config/local-store.js')>()
	return { ...actual, writeJsonState: vi.fn(actual.writeJsonState) }
})

const actualStore = await vi.importActual<typeof import('../src/config/local-store.js')>('../src/config/local-store.js')

function senderWithKey(publicKey: Buffer, overrides: Partial<{ isActive: boolean }> = {}) {
	return {
		id: 'sender-1',
		senderAddress: 'aisc_sender1',
		senderPublicKeyEd25519: publicKey.toString('base64'),
		trustLevel: 'data' as const,
		label: 'Alice',
		isActive: overrides.isActive ?? true,
		ratifiedAt: null,
	}
}

/**
 * Issue #1944: the human confirms the key the ratify command shows them, re-fetched from the
 * server; the ratification must bind THAT key, never the local entry read at the reconciliation
 * a moment earlier. And a reconciliation made by `serve` while the command writes must not be
 * overwritten by the command's older snapshot.
 */
describe('ratification binds the key shown to the human', () => {
	let dir: string
	let previousXdgConfigHome: string | undefined

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), 'aiscelle-mcp-ratify-binding-'))
		previousXdgConfigHome = process.env.XDG_CONFIG_HOME
		process.env.XDG_CONFIG_HOME = dir
		vi.spyOn(console, 'log').mockImplementation(() => undefined)
	})

	afterEach(async () => {
		vi.mocked(localStore.writeJsonState).mockReset()
		vi.mocked(localStore.writeJsonState).mockImplementation(actualStore.writeJsonState)
		vi.restoreAllMocks()
		if (previousXdgConfigHome === undefined) delete process.env.XDG_CONFIG_HOME
		else process.env.XDG_CONFIG_HOME = previousXdgConfigHome
		await rm(dir, { recursive: true, force: true })
	})

	it('refuses when the key shown differs from the key the local entry holds', async () => {
		const reconciledKey = randomBytes(32)
		const shownKey = randomBytes(32)
		vi.mocked(mailboxClient.fetchAllSenders).mockResolvedValue([senderWithKey(reconciledKey)])
		vi.mocked(mailboxClient.fetchSenderPage).mockResolvedValue({
			items: [senderWithKey(shownKey)],
			nextCursor: null,
		})

		const outcome = await runRatifyCommand({ senderId: 'sender-1', yes: true }).catch((error: Error) => error)

		expect(outcome).toBeInstanceOf(RatificationAbortedError)
		const [entry] = await readAllowlist()
		expect(entry?.ratifiedLocally).toBe(false)
	})

	it('ratifies when the key shown is the key the local entry holds', async () => {
		const key = randomBytes(32)
		vi.mocked(mailboxClient.fetchAllSenders).mockResolvedValue([senderWithKey(key)])
		vi.mocked(mailboxClient.fetchSenderPage).mockResolvedValue({ items: [senderWithKey(key)], nextCursor: null })

		await runRatifyCommand({ senderId: 'sender-1', yes: true })

		const [entry] = await readAllowlist()
		expect(entry?.ratifiedLocally).toBe(true)
	})

	it('a revocation reconciled while the ratification writes is not undone by an older snapshot', async () => {
		const key = randomBytes(32)
		await reconcileAllowlistWithServer([senderWithKey(key)])

		let signalHeld!: () => void
		let release!: () => void
		const held = new Promise<void>((resolve) => (signalHeld = resolve))
		const released = new Promise<void>((resolve) => (release = resolve))
		vi.mocked(localStore.writeJsonState).mockImplementationOnce(async (path, value) => {
			signalHeld()
			await released
			return actualStore.writeJsonState(path, value)
		})

		const ratification = markRatifiedLocally('sender-1', 'data', key.toString('base64'))
		await held
		const revocation = reconcileAllowlistWithServer([senderWithKey(key, { isActive: false })])
		await new Promise((resolve) => setTimeout(resolve, 150))
		release()
		await Promise.all([ratification, revocation])

		expect(await readAllowlist()).toEqual([])
	})
})
