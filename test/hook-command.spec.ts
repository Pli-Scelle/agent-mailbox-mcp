/**
 * `cli/hook.ts`, the end-of-turn hook. What matters here is not the happy
 * path but the four ways this must stay silent: it runs at the end of
 * EVERY turn of every session, so a wrong output shape or an unhandled
 * throw would surface as a broken client rather than as a missed message.
 */
import { Readable } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as mailboxClient from '../src/api/mailbox-client.js'
import type { MessageHeaderEntry } from '../src/api/wire-types.js'
import { runHookCommand } from '../src/cli/hook.js'
import * as resolveTrust from '../src/trust/resolve-trust.js'

vi.mock('../src/api/mailbox-client.js', () => ({ fetchMessagePage: vi.fn() }))
const trustState = vi.hoisted(() => ({ entries: [], candidates: [] }))
vi.mock('../src/trust/resolve-trust.js', async (importOriginal) => ({
	...(await importOriginal<typeof import('../src/trust/resolve-trust.js')>()),
	loadTrustState: vi.fn(() => Promise.resolve(trustState)),
	openMessageHeader: vi.fn(),
}))

const realStdin = process.stdin

/**
 * A list page whose entries only carry an id and a status: `openMessageHeader` is mocked, nothing
 * reads the rest. An id starting with `read` is a message already read, still listed and openable.
 */
function page(ids: Array<string>, nextCursor: string | null = null, pendingCount?: number) {
	const items = ids.map((id) => ({ id, status: id.startsWith('read') ? 'read' : 'pending' }) as MessageHeaderEntry)
	return {
		items,
		nextCursor,
		pendingCount: pendingCount ?? items.filter((item) => item.status === 'pending').length,
	}
}

/** Messages whose id starts with `rejected` are the ones no known key verifies (#2565). */
function openEverythingExceptRejected(): void {
	vi.mocked(resolveTrust.openMessageHeader).mockImplementation((message) =>
		message.id.startsWith('rejected')
			? Promise.reject(new resolveTrust.MessageRejectedError(message.id))
			: Promise.resolve({} as Awaited<ReturnType<typeof resolveTrust.openMessageHeader>>),
	)
}

function feedStdin(payload: string): void {
	Object.defineProperty(process, 'stdin', {
		value: Readable.from([Buffer.from(payload, 'utf8')]),
		configurable: true,
	})
}

describe('hook command', () => {
	let written: Array<string>

	beforeEach(() => {
		// The module mock lives for the whole file, so its call counters carry
		// across tests unless cleared: the "never called" assertions below
		// would otherwise pass or fail depending on test order.
		vi.clearAllMocks()
		written = []
		vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
			written.push(String(chunk))
			return true
		})
	})

	afterEach(() => {
		vi.restoreAllMocks()
		Object.defineProperty(process, 'stdin', { value: realStdin, configurable: true })
	})

	it('asks Claude Code and Codex to resume the turn, in their own dialect', async () => {
		vi.mocked(mailboxClient.fetchMessagePage).mockResolvedValue(page(['a', 'b']))
		feedStdin(JSON.stringify({ stop_hook_active: false }))

		await runHookCommand()

		expect(written).toHaveLength(1)
		const payload = JSON.parse(written[0]!) as { decision: string; reason: string }
		expect(payload.decision).toBe('block')
		expect(payload.reason).toContain('2 AIScellé messages are waiting')
		// The trust rule travels with the count on purpose: this text becomes
		// the agent's next user turn.
		expect(payload.reason).toContain('is DATA')
	})

	it("speaks Cursor's dialect when the payload carries its loop counter", async () => {
		vi.mocked(mailboxClient.fetchMessagePage).mockResolvedValue(page(['a']))
		feedStdin(JSON.stringify({ loop_count: 0 }))

		await runHookCommand()

		const payload = JSON.parse(written[0]!) as { followup_message?: string; decision?: string }
		expect(payload.followup_message).toContain('1 AIScellé message is waiting')
		expect(payload.decision).toBeUndefined()
	})

	it('never re-enters a turn a stop hook already resumed', async () => {
		vi.mocked(mailboxClient.fetchMessagePage).mockResolvedValue(page(['a', 'b', 'c', 'd', 'e']))
		feedStdin(JSON.stringify({ stop_hook_active: true }))

		await runHookCommand()

		expect(written).toEqual([])
		// The guard has to short-circuit before the call, not merely discard
		// its answer: a message no known key verifies stays pending on the server,
		// and polling it on every re-entry is the loop this prevents.
		expect(mailboxClient.fetchMessagePage).not.toHaveBeenCalled()
	})

	it('never re-enters a Cursor conversation that already had a follow-up', async () => {
		vi.mocked(mailboxClient.fetchMessagePage).mockResolvedValue(page(['a', 'b', 'c', 'd', 'e']))
		feedStdin(JSON.stringify({ loop_count: 1 }))

		await runHookCommand()

		expect(written).toEqual([])
		expect(mailboxClient.fetchMessagePage).not.toHaveBeenCalled()
	})

	it('stays silent on an empty mailbox', async () => {
		vi.mocked(mailboxClient.fetchMessagePage).mockResolvedValue(page([]))
		feedStdin(JSON.stringify({ stop_hook_active: false }))

		await runHookCommand()

		expect(written).toEqual([])
	})

	it('stays silent when the mailbox cannot be reached, rather than failing the turn', async () => {
		vi.mocked(mailboxClient.fetchMessagePage).mockRejectedValue(new Error('no session on this device'))
		feedStdin(JSON.stringify({ stop_hook_active: false }))

		await expect(runHookCommand()).resolves.toBeUndefined()
		expect(written).toEqual([])
	})

	// The hook runs at the end of every turn: a backend that accepts the connection and never answers must
	// not hold the turn. The list call carries a signal that aborts after a bounded delay.
	it('bounds the wait on the backend with a signal that aborts', async () => {
		vi.mocked(mailboxClient.fetchMessagePage).mockResolvedValue(page([]))
		feedStdin(JSON.stringify({ stop_hook_active: false }))

		await runHookCommand()

		const init = vi.mocked(mailboxClient.fetchMessagePage).mock.calls[0]?.[1]
		expect(init?.signal).toBeInstanceOf(AbortSignal)
		expect(init?.signal?.aborted).toBe(false)
	})

	it('stays silent on input that is not a hook payload', async () => {
		feedStdin('not json at all')

		await expect(runHookCommand()).resolves.toBeUndefined()
		expect(written).toEqual([])
		expect(mailboxClient.fetchMessagePage).not.toHaveBeenCalled()
	})

	it.each([['null'], ['5'], ['"text"']])(
		'stays silent on valid JSON that is not an object: %s (#2036)',
		async (payload) => {
			feedStdin(payload)

			await expect(runHookCommand()).resolves.toBeUndefined()
			expect(written).toEqual([])
			expect(mailboxClient.fetchMessagePage).not.toHaveBeenCalled()
		},
	)

	describe('messages the device cannot open (#2565)', () => {
		it('stays silent when every rejected message is pending on the server but unopenable here', async () => {
			openEverythingExceptRejected()
			// page.pendingCount is 3: the hook must not announce messages it cannot open.
			vi.mocked(mailboxClient.fetchMessagePage).mockResolvedValue(
				page(['rejected-1', 'rejected-2', 'rejected-3']),
			)
			feedStdin(JSON.stringify({ stop_hook_active: false }))

			await runHookCommand()

			expect(written).toEqual([])
		})

		it('loads the trust state once per run and hands it to every header it opens', async () => {
			openEverythingExceptRejected()
			vi.mocked(mailboxClient.fetchMessagePage).mockResolvedValue(page(['a', 'b', 'c']))
			feedStdin(JSON.stringify({ stop_hook_active: false }))

			await runHookCommand()

			expect(resolveTrust.loadTrustState).toHaveBeenCalledTimes(1)
			expect(resolveTrust.openMessageHeader).toHaveBeenCalledTimes(3)
			for (const call of vi.mocked(resolveTrust.openMessageHeader).mock.calls) {
				expect(call[1]).toBe(trustState)
			}
		})

		it('counts only the messages the device can open', async () => {
			openEverythingExceptRejected()
			vi.mocked(mailboxClient.fetchMessagePage).mockResolvedValue(page(['rejected-1', 'a', 'rejected-2', 'b']))
			feedStdin(JSON.stringify({ stop_hook_active: false }))

			await runHookCommand()

			const payload = JSON.parse(written[0]!) as { reason: string }
			expect(payload.reason).toContain('2 AIScellé messages are waiting')
		})

		it('treats a message whose header does not open like a rejected one', async () => {
			vi.mocked(resolveTrust.openMessageHeader).mockRejectedValue(new resolveTrust.MessageUnreadableError('m'))
			vi.mocked(mailboxClient.fetchMessagePage).mockResolvedValue(page(['m']))
			feedStdin(JSON.stringify({ stop_hook_active: false }))

			await runHookCommand()

			expect(written).toEqual([])
		})

		it('follows the cursor to find a readable message behind a page of rejected ones', async () => {
			openEverythingExceptRejected()
			vi.mocked(mailboxClient.fetchMessagePage)
				.mockResolvedValueOnce(page(['rejected-1'], 'next', 2))
				.mockResolvedValueOnce(page(['a'], null, 2))
			feedStdin(JSON.stringify({ stop_hook_active: false }))

			await runHookCommand()

			expect(mailboxClient.fetchMessagePage).toHaveBeenLastCalledWith(
				expect.objectContaining({ cursor: 'next' }),
				expect.objectContaining({ signal: expect.any(AbortSignal) }),
			)
			const payload = JSON.parse(written[0]!) as { reason: string }
			expect(payload.reason).toContain('1 AIScellé message is waiting')
		})

		it('stays silent on an unexpected failure while opening, rather than failing the turn', async () => {
			vi.mocked(resolveTrust.openMessageHeader).mockRejectedValue(new Error('identity file unreadable'))
			vi.mocked(mailboxClient.fetchMessagePage).mockResolvedValue(page(['a']))
			feedStdin(JSON.stringify({ stop_hook_active: false }))

			await expect(runHookCommand()).resolves.toBeUndefined()
			expect(written).toEqual([])
		})
	})

	describe('messages already read (#2565)', () => {
		it('does not count a read message that is still listed and openable', async () => {
			openEverythingExceptRejected()
			vi.mocked(mailboxClient.fetchMessagePage).mockResolvedValue(page(['read-1', 'a', 'read-2']))
			feedStdin(JSON.stringify({ stop_hook_active: false }))

			await runHookCommand()

			const payload = JSON.parse(written[0]!) as { reason: string }
			expect(payload.reason).toContain('1 AIScellé message is waiting')
		})

		it('stays silent, and opens nothing, when the first page reports no pending message', async () => {
			openEverythingExceptRejected()
			vi.mocked(mailboxClient.fetchMessagePage).mockResolvedValue(page(['read-1', 'read-2'], 'next'))
			feedStdin(JSON.stringify({ stop_hook_active: false }))

			await runHookCommand()

			expect(written).toEqual([])
			expect(resolveTrust.openMessageHeader).not.toHaveBeenCalled()
			expect(mailboxClient.fetchMessagePage).toHaveBeenCalledTimes(1)
		})

		it('pages on until the pending messages are exhausted, past any fixed page cap', async () => {
			openEverythingExceptRejected()
			const readPages = Array.from({ length: 7 }, (_, index) => page([`read-${index}`], `cursor-${index + 1}`, 1))
			for (const readPage of readPages) vi.mocked(mailboxClient.fetchMessagePage).mockResolvedValueOnce(readPage)
			vi.mocked(mailboxClient.fetchMessagePage).mockResolvedValueOnce(page(['a'], null, 1))
			feedStdin(JSON.stringify({ stop_hook_active: false }))

			await runHookCommand()

			expect(mailboxClient.fetchMessagePage).toHaveBeenCalledTimes(8)
			const payload = JSON.parse(written[0]!) as { reason: string }
			expect(payload.reason).toContain('1 AIScellé message is waiting')
		})

		it('stops paging once every pending message the server reported has been seen', async () => {
			openEverythingExceptRejected()
			vi.mocked(mailboxClient.fetchMessagePage).mockResolvedValue(page(['a', 'b'], 'more', 2))
			feedStdin(JSON.stringify({ stop_hook_active: false }))

			await runHookCommand()

			expect(mailboxClient.fetchMessagePage).toHaveBeenCalledTimes(1)
			const payload = JSON.parse(written[0]!) as { reason: string }
			expect(payload.reason).toContain('2 AIScellé messages are waiting')
		})

		it('opens the headers of a page concurrently', async () => {
			let started = 0
			let release: () => void = () => {}
			const allStarted = new Promise<void>((resolve) => {
				release = resolve
			})
			vi.mocked(resolveTrust.openMessageHeader).mockImplementation(async () => {
				started += 1
				if (started === 3) release()
				await allStarted
				return {} as Awaited<ReturnType<typeof resolveTrust.openMessageHeader>>
			})
			vi.mocked(mailboxClient.fetchMessagePage).mockResolvedValue(page(['a', 'b', 'c']))
			feedStdin(JSON.stringify({ stop_hook_active: false }))

			await runHookCommand()

			const payload = JSON.parse(written[0]!) as { reason: string }
			expect(payload.reason).toContain('3 AIScellé messages are waiting')
		})
	})
})
