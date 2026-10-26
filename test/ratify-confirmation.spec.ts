import { randomBytes } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as mailboxClient from '../src/api/mailbox-client.js'
import { readAllowlist } from '../src/trust/allowlist-store.js'
import { RatificationAbortedError, runRatifyCommand } from '../src/trust/ratify.js'

vi.mock('../src/api/mailbox-client.js', () => ({
	fetchAllSenders: vi.fn(),
	fetchSenderPage: vi.fn(),
}))

const prompt = vi.hoisted(() => ({ answer: '', questions: [] as Array<string> }))

vi.mock('node:readline/promises', () => ({
	createInterface: () => ({
		question: (question: string) => {
			prompt.questions.push(question)
			return Promise.resolve(prompt.answer)
		},
		close: () => undefined,
	}),
}))

function dataLevelSender() {
	return {
		id: 'sender-1',
		senderAddress: 'aisc_sender1',
		senderPublicKeyEd25519: randomBytes(32).toString('base64'),
		trustLevel: 'data' as const,
		label: 'Alice',
		isActive: true,
		ratifiedAt: null,
	}
}

/**
 * The prompt of the plain confirmation is written in French, so the answer the person gives is
 * French too: "o" for oui. Before, only the English "y" was accepted and the prompt said `[y/N]`.
 */
describe('plain ratification confirmation', () => {
	let dir: string
	let previousXdgConfigHome: string | undefined

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), 'aiscelle-mcp-ratify-confirmation-'))
		previousXdgConfigHome = process.env.XDG_CONFIG_HOME
		process.env.XDG_CONFIG_HOME = dir
		prompt.questions = []
		const sender = dataLevelSender()
		vi.mocked(mailboxClient.fetchAllSenders).mockResolvedValue([sender])
		vi.mocked(mailboxClient.fetchSenderPage).mockResolvedValue({ items: [sender], nextCursor: null })
		vi.spyOn(console, 'log').mockImplementation(() => undefined)
	})

	afterEach(async () => {
		vi.restoreAllMocks()
		if (previousXdgConfigHome === undefined) delete process.env.XDG_CONFIG_HOME
		else process.env.XDG_CONFIG_HOME = previousXdgConfigHome
		await rm(dir, { recursive: true, force: true })
	})

	it.each(['o', 'O', 'y', 'Y'])('ratifies on the answer %s', async (answer) => {
		prompt.answer = answer

		await runRatifyCommand({ senderId: 'sender-1' })

		const [entry] = await readAllowlist()
		expect(entry?.ratifiedLocally).toBe(true)
	})

	it.each(['n', '', 'non'])('refuses on the answer "%s"', async (answer) => {
		prompt.answer = answer

		const outcome = await runRatifyCommand({ senderId: 'sender-1' }).catch((error: Error) => error)

		expect(outcome).toBeInstanceOf(RatificationAbortedError)
		const [entry] = await readAllowlist()
		expect(entry?.ratifiedLocally).toBe(false)
	})

	it('offers the French answer in the prompt', async () => {
		prompt.answer = 'o'

		await runRatifyCommand({ senderId: 'sender-1' })

		expect(prompt.questions).toEqual(['Ratifier ce correspondant au niveau données ? [o/N] '])
	})
})
