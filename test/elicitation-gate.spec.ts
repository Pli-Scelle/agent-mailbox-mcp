import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { ClientCapabilities } from '@modelcontextprotocol/sdk/types.js'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HOST_PROCESS_KEY_PREFIX } from '../src/elicitation/conversation-id.js'
import { commitAllowedAction, evaluateElicitationGate } from '../src/elicitation/elicitation-gate.js'
import { lookupConversationState, markConversationRead } from '../src/elicitation/elicitation-store.js'

/**
 * The conversation key is the parent pid, so a test names a conversation by
 * forcing `process.ppid` to a distinct fake pid per name. `vi.restoreAllMocks()`
 * in `afterEach` undoes it.
 */
const fakePids = new Map<string, number>()

function pidFor(name: string): number {
	if (!fakePids.has(name)) fakePids.set(name, 100000 + fakePids.size)
	return fakePids.get(name)!
}

function keyFor(name: string): string {
	return `${HOST_PROCESS_KEY_PREFIX}${pidFor(name)}`
}

/** `undefined` keeps whatever `process.ppid` currently is. */
function evaluateInConversation(
	server: McpServer,
	name: string | undefined,
	options: Parameters<typeof evaluateElicitationGate>[1],
) {
	if (name !== undefined) vi.spyOn(process, 'ppid', 'get').mockReturnValue(pidFor(name))
	return evaluateElicitationGate(server, options)
}

function buildServer(clientCapabilities: ClientCapabilities | undefined) {
	const server = new McpServer({ name: 'test', version: '0.0.0' }, { capabilities: { logging: {} } })
	vi.spyOn(server.server, 'getClientCapabilities').mockReturnValue(clientCapabilities)
	// Defaults to 'accept' so a test that does not care about the exact
	// elicitation outcome never depends on the real (unconnected) transport
	// implementation; a test that DOES care overrides this per call.
	const elicitSpy = vi.spyOn(server.server, 'elicitInput').mockResolvedValue({ action: 'accept' })
	return { server, elicitSpy }
}

const WITH_ELICITATION: ClientCapabilities = { elicitation: { form: {} } }

describe('evaluateElicitationGate', () => {
	let dir: string
	let previousXdgConfigHome: string | undefined

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), 'aiscelle-mcp-elicitation-gate-test-'))
		previousXdgConfigHome = process.env.XDG_CONFIG_HOME
		process.env.XDG_CONFIG_HOME = dir
	})

	afterEach(async () => {
		if (previousXdgConfigHome === undefined) delete process.env.XDG_CONFIG_HOME
		else process.env.XDG_CONFIG_HOME = previousXdgConfigHome
		await rm(dir, { recursive: true, force: true })
		// One test forces `process.ppid`; left in place it would silently
		// reshape every conversation key that follows.
		vi.restoreAllMocks()
	})

	/**
	 * Writes the local allowlist the unattended branch reads, into the same
	 * temporary config dir `beforeEach` just set up.
	 */
	async function writeAllowlistFixture(
		entries: Array<{ address: string; ratifiedLocally: boolean; label?: string }>,
	): Promise<void> {
		const full = entries.map((entry, index) => ({
			serverSenderId: `sender-${index}`,
			address: entry.address,
			publicKeyEd25519: 'AAAA',
			trustLevel: 'data' as const,
			label: entry.label ?? `Label ${index}`,
			isActiveOnServer: true,
			ratifiedLocally: entry.ratifiedLocally,
			ratifiedLocallyAt: entry.ratifiedLocally ? new Date().toISOString() : null,
		}))
		await mkdir(join(dir, 'pliscelle-mcp'), { recursive: true })
		await writeFile(join(dir, 'pliscelle-mcp', 'allowlist.json'), JSON.stringify({ entries: full }), 'utf8')
	}

	it('allows a send with no prior read, without ever asking the client to elicit (nominal path stays frictionless)', async () => {
		const { server, elicitSpy } = buildServer(WITH_ELICITATION)
		elicitSpy.mockResolvedValue({ action: 'accept' })

		const first = await evaluateInConversation(server, 'fresh-but-touched', {
			tool: 'send',
			buildConfirmationMessage: () => 'confirm?',
			unattended: false,
		})

		// A conversation that has never touched anything has no record yet,
		// which is the gate's own "no exploitable state" case and DOES
		// require elicitation on its very first gated call: establish a
		// clean baseline first, the way tools/inbox.ts does, then verify the
		// frictionless path on the call that follows it.
		expect(first.allowed).toBe(true)
		expect(elicitSpy).toHaveBeenCalledTimes(1)
		await commitAllowedAction(first.conversationId)
		elicitSpy.mockClear()

		const second = await evaluateInConversation(server, 'fresh-but-touched', {
			tool: 'send',
			buildConfirmationMessage: () => 'confirm?',
			unattended: false,
		})
		expect(second).toEqual({ allowed: true, conversationId: keyFor('fresh-but-touched') })
		expect(elicitSpy).not.toHaveBeenCalled()
	})

	it('requires elicitation for a conversation that has no record at all', async () => {
		const { server, elicitSpy } = buildServer(WITH_ELICITATION)
		const outcome = await evaluateInConversation(server, 'never-seen', {
			tool: 'send',
			buildConfirmationMessage: () => 'confirm?',
			unattended: false,
		})
		// Unconditionally asked, never silently skipped, even though
		// nothing was ever actually read in this conversation.
		expect(elicitSpy).toHaveBeenCalledTimes(1)
		expect(outcome).toEqual({ allowed: true, conversationId: keyFor('never-seen') })
	})

	it('requires elicitation for a conversation with no exploitable identifier at all', async () => {
		// The conversation key is the host-process key
		// (conversation-id.ts), so the only way left to reach the "no
		// identifier" case is a process with no usable parent. Forced here
		// rather than assumed, since it cannot occur under a test runner.
		vi.spyOn(process, 'ppid', 'get').mockReturnValue(0)
		const { server, elicitSpy } = buildServer(WITH_ELICITATION)
		const outcome = await evaluateInConversation(server, undefined, {
			tool: 'send',
			buildConfirmationMessage: () => 'confirm?',
			unattended: false,
		})
		// Nothing to key a request on, but the point still stands: it must
		// still go through the capability+elicitation path, not silently pass.
		expect(elicitSpy).toHaveBeenCalledTimes(1)
		expect(outcome).toEqual({ allowed: true, conversationId: undefined })
	})

	it('falls back to the host-process key when the client supplies none, instead of losing all state', async () => {
		const { server, elicitSpy } = buildServer(WITH_ELICITATION)

		const first = await evaluateInConversation(server, undefined, {
			tool: 'send',
			buildConfirmationMessage: () => 'confirm?',
			unattended: false,
		})
		// The very first gated call of a brand new conversation is elicited,
		// exactly as it is for a client-supplied id: what changes is that the
		// outcome is now persisted under a key that exists.
		expect(elicitSpy).toHaveBeenCalledTimes(1)
		expect(first.conversationId).toBe(`${HOST_PROCESS_KEY_PREFIX}${process.ppid}`)
		await commitAllowedAction(first.conversationId)
		elicitSpy.mockClear()

		const second = await evaluateInConversation(server, undefined, {
			tool: 'send',
			buildConfirmationMessage: () => 'confirm?',
			unattended: false,
		})
		expect(second.allowed).toBe(true)
		expect(elicitSpy).not.toHaveBeenCalled()
	})

	it('shares one host-process key across every conversation of that host, arming the gate for all of them after one read', async () => {
		// The documented cost of the fallback key (conversation-id.ts): its
		// granularity is the host process, not the conversation. Asserted here
		// rather than left implicit, because it is what a reader would
		// otherwise assume away.
		const { server, elicitSpy } = buildServer(WITH_ELICITATION)
		const firstConversation = await evaluateInConversation(server, undefined, {
			tool: 'send',
			buildConfirmationMessage: () => 'confirm?',
			unattended: false,
		})
		await commitAllowedAction(firstConversation.conversationId)
		elicitSpy.mockClear()

		// A read happening in one conversation of this host.
		await markConversationRead(`${HOST_PROCESS_KEY_PREFIX}${process.ppid}`)

		// Another conversation of the same host, which read nothing, is gated.
		await evaluateInConversation(server, undefined, {
			tool: 'send',
			buildConfirmationMessage: () => 'confirm?',
			unattended: false,
		})
		expect(elicitSpy).toHaveBeenCalledTimes(1)
	})

	it('triggers elicitation for a send after a read in the same conversation', async () => {
		await markConversationRead(keyFor('read-then-send'))
		const { server, elicitSpy } = buildServer(WITH_ELICITATION)
		elicitSpy.mockResolvedValue({ action: 'accept' })

		const outcome = await evaluateInConversation(server, 'read-then-send', {
			tool: 'send',
			buildConfirmationMessage: () => 'confirm?',
			unattended: false,
		})

		expect(outcome).toEqual({ allowed: true, conversationId: keyFor('read-then-send') })
		expect(elicitSpy).toHaveBeenCalledTimes(1)
		const [params] = elicitSpy.mock.calls[0] as unknown as [{ requestedSchema: unknown }]
		expect(params.requestedSchema).toEqual({ type: 'object', properties: {} })
	})

	it('survives a persisted-state read across what stands in for an MCP process restart: a fresh gate call still sees the earlier read', async () => {
		await markConversationRead(keyFor('restart-conversation'))
		// Simulates a fresh process: a brand new McpServer instance, same
		// conversation id, reading the SAME on-disk store rather than any
		// in-memory state this process might otherwise have kept.
		const { server, elicitSpy } = buildServer(WITH_ELICITATION)
		elicitSpy.mockResolvedValue({ action: 'accept' })

		const outcome = await evaluateInConversation(server, 'restart-conversation', {
			tool: 'send',
			buildConfirmationMessage: () => 'confirm?',
			unattended: false,
		})
		expect(outcome.allowed).toBe(true)
		expect(elicitSpy).toHaveBeenCalledTimes(1)
	})

	it('triggers elicitation for a purge requested after a read', async () => {
		await markConversationRead(keyFor('read-then-purge'))
		const { server, elicitSpy } = buildServer(WITH_ELICITATION)
		elicitSpy.mockResolvedValue({ action: 'accept' })

		const outcome = await evaluateInConversation(server, 'read-then-purge', {
			tool: 'purge',
			buildConfirmationMessage: () => 'confirm?',
			unattended: false,
		})
		expect(outcome.allowed).toBe(true)
		expect(elicitSpy).toHaveBeenCalledTimes(1)
	})

	it('refuses send/purge outright when the client declares no elicitation capability, after a read', async () => {
		await markConversationRead(keyFor('no-capability-conversation'))
		const { server, elicitSpy } = buildServer(undefined)

		const outcome = await evaluateInConversation(server, 'no-capability-conversation', {
			tool: 'send',
			buildConfirmationMessage: () => 'confirm?',
			unattended: false,
		})
		expect(outcome).toEqual({
			allowed: false,
			reason: 'no_capability',
			conversationId: keyFor('no-capability-conversation'),
		})
		expect(elicitSpy).not.toHaveBeenCalled()
	})

	it('refuses purge too, not just send, when the client declares no elicitation capability, after a read', async () => {
		await markConversationRead(keyFor('no-capability-purge-conversation'))
		const { server, elicitSpy } = buildServer(undefined)

		const outcome = await evaluateInConversation(server, 'no-capability-purge-conversation', {
			tool: 'purge',
			buildConfirmationMessage: () => 'confirm?',
			unattended: false,
		})
		expect(outcome).toEqual({
			allowed: false,
			reason: 'no_capability',
			conversationId: keyFor('no-capability-purge-conversation'),
		})
		expect(elicitSpy).not.toHaveBeenCalled()
	})

	it('refuses when the user declines the elicitation', async () => {
		await markConversationRead(keyFor('decline-conversation'))
		const { server, elicitSpy } = buildServer(WITH_ELICITATION)
		elicitSpy.mockResolvedValue({ action: 'decline' })

		const outcome = await evaluateInConversation(server, 'decline-conversation', {
			tool: 'send',
			buildConfirmationMessage: () => 'confirm?',
			unattended: false,
		})
		expect(outcome).toEqual({ allowed: false, reason: 'declined', conversationId: keyFor('decline-conversation') })
	})

	it('refuses when the elicitation is cancelled without an answer', async () => {
		await markConversationRead(keyFor('cancel-conversation'))
		const { server, elicitSpy } = buildServer(WITH_ELICITATION)
		elicitSpy.mockResolvedValue({ action: 'cancel' })

		const outcome = await evaluateInConversation(server, 'cancel-conversation', {
			tool: 'send',
			buildConfirmationMessage: () => 'confirm?',
			unattended: false,
		})
		expect(outcome).toEqual({ allowed: false, reason: 'cancelled', conversationId: keyFor('cancel-conversation') })
	})

	it('refuses, rather than throwing, when the elicitation request itself fails', async () => {
		await markConversationRead(keyFor('failure-conversation'))
		const { server, elicitSpy } = buildServer(WITH_ELICITATION)
		elicitSpy.mockRejectedValue(new Error('transport closed'))

		const outcome = await evaluateInConversation(server, 'failure-conversation', {
			tool: 'send',
			buildConfirmationMessage: () => 'confirm?',
			unattended: false,
		})
		expect(outcome).toEqual({
			allowed: false,
			reason: 'request_failed',
			conversationId: keyFor('failure-conversation'),
		})
	})

	it('still elicits through the gate itself once the record has expired, never reading staleness as proof of no read', async () => {
		vi.useFakeTimers()
		try {
			vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'))
			await markConversationRead(keyFor('expiring-conversation'))

			// One hour past this store's own TTL (elicitation-store.ts's
			// ELICITATION_RECORD_TTL_HOURS = 24): the record is now expired.
			vi.setSystemTime(new Date('2026-01-02T01:00:00.000Z'))
			const { server, elicitSpy } = buildServer(WITH_ELICITATION)
			elicitSpy.mockResolvedValue({ action: 'accept' })

			const outcome = await evaluateInConversation(server, 'expiring-conversation', {
				tool: 'send',
				buildConfirmationMessage: () => 'confirm?',
				unattended: false,
			})
			expect(elicitSpy).toHaveBeenCalledTimes(1)
			expect(outcome.allowed).toBe(true) // accepted, but only after being asked again
		} finally {
			vi.useRealTimers()
		}
	})

	it('triggers elicitation for a send under a different conversation id than the one that read', async () => {
		await markConversationRead(keyFor('conversation-that-read'))
		const { server, elicitSpy } = buildServer(WITH_ELICITATION)
		elicitSpy.mockResolvedValue({ action: 'accept' })

		const outcome = await evaluateInConversation(server, 'a-completely-different-conversation', {
			tool: 'send',
			buildConfirmationMessage: () => 'confirm?',
			unattended: false,
		})
		expect(outcome.allowed).toBe(true) // accepted, but only AFTER being asked
		expect(elicitSpy).toHaveBeenCalledTimes(1)
	})

	it('lets an unattended send through to a locally ratified recipient, without ever eliciting', async () => {
		await markConversationRead(keyFor('unattended-nominal'))
		await writeAllowlistFixture([{ address: 'aisc_ratified', ratifiedLocally: true }])
		const { server, elicitSpy } = buildServer(WITH_ELICITATION)

		const outcome = await evaluateInConversation(server, 'unattended-nominal', {
			tool: 'send',
			buildConfirmationMessage: () => 'confirm?',
			unattended: true,
			recipientAddress: 'aisc_ratified',
		})

		expect(outcome.allowed).toBe(true)
		expect(elicitSpy).not.toHaveBeenCalled()
	})

	it('refuses an unattended send to an address this machine holds no entry for', async () => {
		await markConversationRead(keyFor('unattended-stranger'))
		await writeAllowlistFixture([{ address: 'aisc_ratified', ratifiedLocally: true }])
		const { server, elicitSpy } = buildServer(WITH_ELICITATION)

		const outcome = await evaluateInConversation(server, 'unattended-stranger', {
			tool: 'send',
			buildConfirmationMessage: () => 'confirm?',
			unattended: true,
			recipientAddress: 'aisc_stranger',
		})

		expect(outcome).toMatchObject({ allowed: false, reason: 'unratified_recipient' })
		expect(elicitSpy).not.toHaveBeenCalled()
	})

	it('refuses an unattended send to a correspondent known here but never ratified here', async () => {
		await markConversationRead(keyFor('unattended-server-only'))
		await writeAllowlistFixture([{ address: 'aisc_server_only', ratifiedLocally: false }])
		const { server } = buildServer(WITH_ELICITATION)

		const outcome = await evaluateInConversation(server, 'unattended-server-only', {
			tool: 'send',
			buildConfirmationMessage: () => 'confirm?',
			unattended: true,
			recipientAddress: 'aisc_server_only',
		})

		expect(outcome).toMatchObject({ allowed: false, reason: 'unratified_recipient' })
	})

	it('refuses an unattended send that names no recipient at all, rather than defaulting to allowed', async () => {
		await markConversationRead(keyFor('unattended-no-recipient'))
		await writeAllowlistFixture([{ address: 'aisc_ratified', ratifiedLocally: true }])
		const { server } = buildServer(WITH_ELICITATION)

		const outcome = await evaluateInConversation(server, 'unattended-no-recipient', {
			tool: 'send',
			buildConfirmationMessage: () => 'confirm?',
			unattended: true,
		})

		expect(outcome).toMatchObject({ allowed: false, reason: 'unratified_recipient' })
	})

	it('never composes the confirmation message on a path that does not display it', async () => {
		await markConversationRead(keyFor('unattended-no-prompt'))
		await writeAllowlistFixture([{ address: 'aisc_ratified', ratifiedLocally: true }])
		const { server } = buildServer(WITH_ELICITATION)
		const build = vi.fn(() => 'confirm?')

		await evaluateInConversation(server, 'unattended-no-prompt', {
			tool: 'send',
			buildConfirmationMessage: build,
			unattended: true,
			recipientAddress: 'aisc_ratified',
		})

		// Composing it costs a read of this device's allowlist; unattended mode
		// never shows it, so it must never be paid for.
		expect(build).not.toHaveBeenCalled()
	})

	it('lets an unattended purge through, since it names no recipient and stays inside this mailbox', async () => {
		await markConversationRead(keyFor('unattended-purge'))
		const { server, elicitSpy } = buildServer(WITH_ELICITATION)

		const outcome = await evaluateInConversation(server, 'unattended-purge', {
			tool: 'purge',
			buildConfirmationMessage: () => 'confirm?',
			unattended: true,
		})

		expect(outcome.allowed).toBe(true)
		expect(elicitSpy).not.toHaveBeenCalled()
	})

	it('still elicits when the mode is not declared, even for a ratified recipient', async () => {
		await markConversationRead(keyFor('attended-ratified'))
		await writeAllowlistFixture([{ address: 'aisc_ratified', ratifiedLocally: true }])
		const { server, elicitSpy } = buildServer(WITH_ELICITATION)

		await evaluateInConversation(server, 'attended-ratified', {
			tool: 'send',
			buildConfirmationMessage: () => 'confirm?',
			unattended: false,
			recipientAddress: 'aisc_ratified',
		})

		expect(elicitSpy).toHaveBeenCalledTimes(1)
	})

	it('refuses an unattended send to an unratified address whether or not a read happened: the check never depends on the read state', async () => {
		await writeAllowlistFixture([{ address: 'aisc_ratified', ratifiedLocally: true }])
		const { server, elicitSpy } = buildServer(WITH_ELICITATION)
		const stranger = {
			tool: 'send' as const,
			buildConfirmationMessage: () => 'confirm?',
			unattended: true,
			recipientAddress: 'aisc_stranger',
		}

		// No record at all: a brand new conversation.
		const first = await evaluateInConversation(server, 'unattended-baseline', stranger)
		expect(first).toMatchObject({ allowed: false, reason: 'unratified_recipient' })

		// A baseline exists and nothing was ever read: this is the case the
		// frictionless shortcut used to wave through before the check.
		await commitAllowedAction(keyFor('unattended-baseline'))
		expect(await lookupConversationState(keyFor('unattended-baseline'))).toEqual({
			status: 'known',
			hasRead: false,
		})
		const second = await evaluateInConversation(server, 'unattended-baseline', stranger)
		expect(second).toMatchObject({ allowed: false, reason: 'unratified_recipient' })

		// A read happened.
		await markConversationRead(keyFor('unattended-baseline'))
		const third = await evaluateInConversation(server, 'unattended-baseline', stranger)
		expect(third).toMatchObject({ allowed: false, reason: 'unratified_recipient' })

		expect(elicitSpy).not.toHaveBeenCalled()
	})

	it('refuses an unattended send to an unratified address with no exploitable conversation id', async () => {
		vi.spyOn(process, 'ppid', 'get').mockReturnValue(0)
		await writeAllowlistFixture([{ address: 'aisc_ratified', ratifiedLocally: true }])
		const { server } = buildServer(WITH_ELICITATION)

		const outcome = await evaluateInConversation(server, undefined, {
			tool: 'send',
			buildConfirmationMessage: () => 'confirm?',
			unattended: true,
			recipientAddress: 'aisc_stranger',
		})

		expect(outcome).toMatchObject({ allowed: false, reason: 'unratified_recipient' })
	})

	it('lets an unattended send to a ratified address through in every read state, without eliciting', async () => {
		await writeAllowlistFixture([{ address: 'aisc_ratified', ratifiedLocally: true }])
		const { server, elicitSpy } = buildServer(WITH_ELICITATION)
		const ratified = {
			tool: 'send' as const,
			buildConfirmationMessage: () => 'confirm?',
			unattended: true,
			recipientAddress: 'aisc_ratified',
		}

		const noRecord = await evaluateInConversation(server, 'unattended-ratified', ratified)
		expect(noRecord.allowed).toBe(true)

		await commitAllowedAction(keyFor('unattended-ratified'))
		const noRead = await evaluateInConversation(server, 'unattended-ratified', ratified)
		expect(noRead.allowed).toBe(true)

		await markConversationRead(keyFor('unattended-ratified'))
		const afterRead = await evaluateInConversation(server, 'unattended-ratified', ratified)
		expect(afterRead.allowed).toBe(true)

		expect(elicitSpy).not.toHaveBeenCalled()
	})

	it('lets an unattended purge through in every read state, without eliciting', async () => {
		const { server, elicitSpy } = buildServer(WITH_ELICITATION)
		const purge = { tool: 'purge' as const, buildConfirmationMessage: () => 'confirm?', unattended: true }

		const noRecord = await evaluateInConversation(server, 'unattended-purge-states', purge)
		expect(noRecord.allowed).toBe(true)

		await commitAllowedAction(keyFor('unattended-purge-states'))
		const noRead = await evaluateInConversation(server, 'unattended-purge-states', purge)
		expect(noRead.allowed).toBe(true)

		await markConversationRead(keyFor('unattended-purge-states'))
		const afterRead = await evaluateInConversation(server, 'unattended-purge-states', purge)
		expect(afterRead.allowed).toBe(true)

		expect(elicitSpy).not.toHaveBeenCalled()
	})

	it('keeps the attended frictionless path unchanged: no read, known conversation, no elicitation even for a stranger', async () => {
		const { server, elicitSpy } = buildServer(WITH_ELICITATION)
		await commitAllowedAction(keyFor('attended-baseline'))

		const outcome = await evaluateInConversation(server, 'attended-baseline', {
			tool: 'send',
			buildConfirmationMessage: () => 'confirm?',
			unattended: false,
			recipientAddress: 'aisc_stranger',
		})

		expect(outcome.allowed).toBe(true)
		expect(elicitSpy).not.toHaveBeenCalled()
	})

	it('commitAllowedAction is a safe no-op when there is no conversation id to persist under', async () => {
		await expect(commitAllowedAction(undefined)).resolves.toBeUndefined()
	})

	it('commitAllowedAction never runs for a refused call: a declined send must not be able to establish a clean baseline for a retry', async () => {
		await markConversationRead(keyFor('declined-then-retry'))
		const { server, elicitSpy } = buildServer(WITH_ELICITATION)
		elicitSpy.mockResolvedValue({ action: 'decline' })

		const outcome = await evaluateInConversation(server, 'declined-then-retry', {
			tool: 'send',
			buildConfirmationMessage: () => 'confirm?',
			unattended: false,
		})
		expect(outcome.allowed).toBe(false)
		// The caller (tools/send.ts) never calls commitAllowedAction on a
		// refusal; simulate that discipline and assert the record is
		// untouched, still requiring elicitation.
		expect(await lookupConversationState(keyFor('declined-then-retry'))).toEqual({ status: 'known', hasRead: true })
	})
})
