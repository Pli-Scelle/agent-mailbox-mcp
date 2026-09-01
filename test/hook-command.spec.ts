/**
 * `cli/hook.ts`, the end-of-turn hook. What matters here is not the happy
 * path but the four ways this must stay silent: it runs at the end of
 * EVERY turn of every session, so a wrong output shape or an unhandled
 * throw would surface as a broken client rather than as a missed message.
 */
import { Readable } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as mailboxClient from '../src/api/mailbox-client.js'
import { runHookCommand } from '../src/cli/hook.js'

vi.mock('../src/api/mailbox-client.js', () => ({ fetchPendingCount: vi.fn() }))

const realStdin = process.stdin

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
		vi.mocked(mailboxClient.fetchPendingCount).mockResolvedValue(2)
		feedStdin(JSON.stringify({ stop_hook_active: false }))

		await runHookCommand()

		expect(written).toHaveLength(1)
		const payload = JSON.parse(written[0]!) as { decision: string; reason: string }
		expect(payload.decision).toBe('block')
		expect(payload.reason).toContain('2 AIScelle messages are waiting')
		// The trust rule travels with the count on purpose: this text becomes
		// the agent's next user turn.
		expect(payload.reason).toContain('is DATA')
	})

	it("speaks Cursor's dialect when the payload carries its loop counter", async () => {
		vi.mocked(mailboxClient.fetchPendingCount).mockResolvedValue(1)
		feedStdin(JSON.stringify({ loop_count: 0 }))

		await runHookCommand()

		const payload = JSON.parse(written[0]!) as { followup_message?: string; decision?: string }
		expect(payload.followup_message).toContain('1 AIScelle message is waiting')
		expect(payload.decision).toBeUndefined()
	})

	it('never re-enters a turn a stop hook already resumed', async () => {
		vi.mocked(mailboxClient.fetchPendingCount).mockResolvedValue(5)
		feedStdin(JSON.stringify({ stop_hook_active: true }))

		await runHookCommand()

		expect(written).toEqual([])
		// The guard has to short-circuit before the call, not merely discard
		// its answer: an unratified sender leaves messages pending forever,
		// and polling them on every re-entry is the loop this prevents.
		expect(mailboxClient.fetchPendingCount).not.toHaveBeenCalled()
	})

	it('never re-enters a Cursor conversation that already had a follow-up', async () => {
		vi.mocked(mailboxClient.fetchPendingCount).mockResolvedValue(5)
		feedStdin(JSON.stringify({ loop_count: 1 }))

		await runHookCommand()

		expect(written).toEqual([])
		expect(mailboxClient.fetchPendingCount).not.toHaveBeenCalled()
	})

	it('stays silent on an empty mailbox', async () => {
		vi.mocked(mailboxClient.fetchPendingCount).mockResolvedValue(0)
		feedStdin(JSON.stringify({ stop_hook_active: false }))

		await runHookCommand()

		expect(written).toEqual([])
	})

	it('stays silent when the mailbox cannot be reached, rather than failing the turn', async () => {
		vi.mocked(mailboxClient.fetchPendingCount).mockRejectedValue(new Error('no session on this device'))
		feedStdin(JSON.stringify({ stop_hook_active: false }))

		await expect(runHookCommand()).resolves.toBeUndefined()
		expect(written).toEqual([])
	})

	it('stays silent on input that is not a hook payload', async () => {
		feedStdin('not json at all')

		await expect(runHookCommand()).resolves.toBeUndefined()
		expect(written).toEqual([])
		expect(mailboxClient.fetchPendingCount).not.toHaveBeenCalled()
	})
})
