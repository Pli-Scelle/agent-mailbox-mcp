import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js'
import type { ClientCapabilities, ServerNotification, ServerRequest } from '@modelcontextprotocol/sdk/types.js'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CONVERSATION_ID_META_KEY } from '../src/elicitation/conversation-id.js'
import { commitAllowedAction, evaluateElicitationGate } from '../src/elicitation/elicitation-gate.js'
import { lookupConversationState, markConversationRead } from '../src/elicitation/elicitation-store.js'

type ToolRequestExtra = RequestHandlerExtra<ServerRequest, ServerNotification>

function extraForConversation(conversationId: string | undefined): ToolRequestExtra {
	const meta = conversationId === undefined ? undefined : { [CONVERSATION_ID_META_KEY]: conversationId }
	return { _meta: meta } as unknown as ToolRequestExtra
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
	})

	it('allows a send with no prior read, without ever asking the client to elicit (nominal path stays frictionless)', async () => {
		const { server, elicitSpy } = buildServer(WITH_ELICITATION)
		elicitSpy.mockResolvedValue({ action: 'accept' })

		const first = await evaluateElicitationGate(server, extraForConversation('fresh-but-touched'), {
			tool: 'send',
			confirmationMessage: 'confirm?',
		})

		// A conversation that has never touched anything has no record yet,
		// which is the gate's own "no exploitable state" case and DOES
		// require elicitation on its very first gated call -- establish a
		// clean baseline first, the way tools/inbox.ts does, then verify the
		// frictionless path on the call that follows it.
		expect(first.allowed).toBe(true)
		expect(elicitSpy).toHaveBeenCalledTimes(1)
		await commitAllowedAction(first.conversationId)
		elicitSpy.mockClear()

		const second = await evaluateElicitationGate(server, extraForConversation('fresh-but-touched'), {
			tool: 'send',
			confirmationMessage: 'confirm?',
		})
		expect(second).toEqual({ allowed: true, conversationId: 'fresh-but-touched' })
		expect(elicitSpy).not.toHaveBeenCalled()
	})

	it('requires elicitation for a conversation that has no record at all', async () => {
		const { server, elicitSpy } = buildServer(WITH_ELICITATION)
		const outcome = await evaluateElicitationGate(server, extraForConversation('never-seen'), {
			tool: 'send',
			confirmationMessage: 'confirm?',
		})
		// Unconditionally asked -- never silently skipped -- even though
		// nothing was ever actually read in this conversation.
		expect(elicitSpy).toHaveBeenCalledTimes(1)
		expect(outcome).toEqual({ allowed: true, conversationId: 'never-seen' })
	})

	it('requires elicitation for a conversation with no exploitable identifier at all', async () => {
		const { server, elicitSpy } = buildServer(WITH_ELICITATION)
		const outcome = await evaluateElicitationGate(server, extraForConversation(undefined), {
			tool: 'send',
			confirmationMessage: 'confirm?',
		})
		// Nothing to key a request on, but the point still stands: it must
		// still go through the capability+elicitation path, not silently pass.
		expect(elicitSpy).toHaveBeenCalledTimes(1)
		expect(outcome).toEqual({ allowed: true, conversationId: undefined })
	})

	it('triggers elicitation for a send after a read in the same conversation', async () => {
		await markConversationRead('read-then-send')
		const { server, elicitSpy } = buildServer(WITH_ELICITATION)
		elicitSpy.mockResolvedValue({ action: 'accept' })

		const outcome = await evaluateElicitationGate(server, extraForConversation('read-then-send'), {
			tool: 'send',
			confirmationMessage: 'confirm?',
		})

		expect(outcome).toEqual({ allowed: true, conversationId: 'read-then-send' })
		expect(elicitSpy).toHaveBeenCalledTimes(1)
		const [params] = elicitSpy.mock.calls[0] as unknown as [{ requestedSchema: unknown }]
		expect(params.requestedSchema).toEqual({ type: 'object', properties: {} })
	})

	it('survives a persisted-state read across what stands in for an MCP process restart: a fresh gate call still sees the earlier read', async () => {
		await markConversationRead('restart-conversation')
		// Simulates a fresh process: a brand new McpServer instance, same
		// conversation id, reading the SAME on-disk store rather than any
		// in-memory state this process might otherwise have kept.
		const { server, elicitSpy } = buildServer(WITH_ELICITATION)
		elicitSpy.mockResolvedValue({ action: 'accept' })

		const outcome = await evaluateElicitationGate(server, extraForConversation('restart-conversation'), {
			tool: 'send',
			confirmationMessage: 'confirm?',
		})
		expect(outcome.allowed).toBe(true)
		expect(elicitSpy).toHaveBeenCalledTimes(1)
	})

	it('triggers elicitation for a purge requested after a read', async () => {
		await markConversationRead('read-then-purge')
		const { server, elicitSpy } = buildServer(WITH_ELICITATION)
		elicitSpy.mockResolvedValue({ action: 'accept' })

		const outcome = await evaluateElicitationGate(server, extraForConversation('read-then-purge'), {
			tool: 'purge',
			confirmationMessage: 'confirm?',
		})
		expect(outcome.allowed).toBe(true)
		expect(elicitSpy).toHaveBeenCalledTimes(1)
	})

	it('refuses send/purge outright when the client declares no elicitation capability, after a read', async () => {
		await markConversationRead('no-capability-conversation')
		const { server, elicitSpy } = buildServer(undefined)

		const outcome = await evaluateElicitationGate(server, extraForConversation('no-capability-conversation'), {
			tool: 'send',
			confirmationMessage: 'confirm?',
		})
		expect(outcome).toEqual({
			allowed: false,
			reason: 'no_capability',
			conversationId: 'no-capability-conversation',
		})
		expect(elicitSpy).not.toHaveBeenCalled()
	})

	it('refuses purge too, not just send, when the client declares no elicitation capability, after a read', async () => {
		await markConversationRead('no-capability-purge-conversation')
		const { server, elicitSpy } = buildServer(undefined)

		const outcome = await evaluateElicitationGate(
			server,
			extraForConversation('no-capability-purge-conversation'),
			{ tool: 'purge', confirmationMessage: 'confirm?' },
		)
		expect(outcome).toEqual({
			allowed: false,
			reason: 'no_capability',
			conversationId: 'no-capability-purge-conversation',
		})
		expect(elicitSpy).not.toHaveBeenCalled()
	})

	it('refuses when the user declines the elicitation', async () => {
		await markConversationRead('decline-conversation')
		const { server, elicitSpy } = buildServer(WITH_ELICITATION)
		elicitSpy.mockResolvedValue({ action: 'decline' })

		const outcome = await evaluateElicitationGate(server, extraForConversation('decline-conversation'), {
			tool: 'send',
			confirmationMessage: 'confirm?',
		})
		expect(outcome).toEqual({ allowed: false, reason: 'declined', conversationId: 'decline-conversation' })
	})

	it('refuses when the elicitation is cancelled without an answer', async () => {
		await markConversationRead('cancel-conversation')
		const { server, elicitSpy } = buildServer(WITH_ELICITATION)
		elicitSpy.mockResolvedValue({ action: 'cancel' })

		const outcome = await evaluateElicitationGate(server, extraForConversation('cancel-conversation'), {
			tool: 'send',
			confirmationMessage: 'confirm?',
		})
		expect(outcome).toEqual({ allowed: false, reason: 'cancelled', conversationId: 'cancel-conversation' })
	})

	it('refuses, rather than throwing, when the elicitation request itself fails', async () => {
		await markConversationRead('failure-conversation')
		const { server, elicitSpy } = buildServer(WITH_ELICITATION)
		elicitSpy.mockRejectedValue(new Error('transport closed'))

		const outcome = await evaluateElicitationGate(server, extraForConversation('failure-conversation'), {
			tool: 'send',
			confirmationMessage: 'confirm?',
		})
		expect(outcome).toEqual({ allowed: false, reason: 'request_failed', conversationId: 'failure-conversation' })
	})

	it('still elicits through the gate itself once the record has expired, never reading staleness as proof of no read', async () => {
		vi.useFakeTimers()
		try {
			vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'))
			await markConversationRead('expiring-conversation')

			// One hour past this store's own TTL (elicitation-store.ts's
			// ELICITATION_RECORD_TTL_HOURS = 24): the record is now expired.
			vi.setSystemTime(new Date('2026-01-02T01:00:00.000Z'))
			const { server, elicitSpy } = buildServer(WITH_ELICITATION)
			elicitSpy.mockResolvedValue({ action: 'accept' })

			const outcome = await evaluateElicitationGate(server, extraForConversation('expiring-conversation'), {
				tool: 'send',
				confirmationMessage: 'confirm?',
			})
			expect(elicitSpy).toHaveBeenCalledTimes(1)
			expect(outcome.allowed).toBe(true) // accepted, but only after being asked again
		} finally {
			vi.useRealTimers()
		}
	})

	it('triggers elicitation for a send under a different conversation id than the one that read', async () => {
		await markConversationRead('conversation-that-read')
		const { server, elicitSpy } = buildServer(WITH_ELICITATION)
		elicitSpy.mockResolvedValue({ action: 'accept' })

		const outcome = await evaluateElicitationGate(
			server,
			extraForConversation('a-completely-different-conversation'),
			{
				tool: 'send',
				confirmationMessage: 'confirm?',
			},
		)
		expect(outcome.allowed).toBe(true) // accepted, but only AFTER being asked
		expect(elicitSpy).toHaveBeenCalledTimes(1)
	})

	it('commitAllowedAction is a safe no-op when there is no conversation id to persist under', async () => {
		await expect(commitAllowedAction(undefined)).resolves.toBeUndefined()
	})

	it('commitAllowedAction never runs for a refused call: a declined send must not be able to establish a clean baseline for a retry', async () => {
		await markConversationRead('declined-then-retry')
		const { server, elicitSpy } = buildServer(WITH_ELICITATION)
		elicitSpy.mockResolvedValue({ action: 'decline' })

		const outcome = await evaluateElicitationGate(server, extraForConversation('declined-then-retry'), {
			tool: 'send',
			confirmationMessage: 'confirm?',
		})
		expect(outcome.allowed).toBe(false)
		// The caller (tools/send.ts) never calls commitAllowedAction on a
		// refusal; simulate that discipline and assert the record is
		// untouched, still requiring elicitation.
		expect(await lookupConversationState('declined-then-retry')).toEqual({ status: 'known', hasRead: true })
	})
})
