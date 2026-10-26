import { describe, expect, it } from 'vitest'
import { HOST_PROCESS_KEY_PREFIX, resolveConversationId } from '../src/elicitation/conversation-id.js'

const HOST_PROCESS_KEY = `${HOST_PROCESS_KEY_PREFIX}${process.ppid}`

describe('resolveConversationId', () => {
	it('returns the host-process key', () => {
		expect(resolveConversationId()).toBe(HOST_PROCESS_KEY)
	})

	it('ignores a conversation id a client puts under the former _meta key (issue #2069)', () => {
		// The former signature took the request extra and read this key first.
		// A caller still passing it must get the host-process key, not the value.
		const legacyResolve = resolveConversationId as (extra: unknown) => string | undefined
		const extra = { _meta: { 'com.pliscelle/conversationId': 'client-supplied' } }
		expect(legacyResolve(extra)).toBe(HOST_PROCESS_KEY)
	})

	it('never returns the bare prefix, so an id is always a real, non-empty key', () => {
		expect(resolveConversationId()).not.toBe(HOST_PROCESS_KEY_PREFIX)
	})
})
