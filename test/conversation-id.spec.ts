import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js'
import type { ServerNotification, ServerRequest } from '@modelcontextprotocol/sdk/types.js'
import { describe, expect, it } from 'vitest'
import {
	CONVERSATION_ID_META_KEY,
	HOST_PROCESS_KEY_PREFIX,
	resolveConversationId,
} from '../src/elicitation/conversation-id.js'

type ToolRequestExtra = RequestHandlerExtra<ServerRequest, ServerNotification>

function extraWithMeta(meta: Record<string, unknown> | undefined): ToolRequestExtra {
	return { _meta: meta } as unknown as ToolRequestExtra
}

const HOST_PROCESS_KEY = `${HOST_PROCESS_KEY_PREFIX}${process.ppid}`

describe('resolveConversationId', () => {
	it("returns the value under this package's own _meta key when present", () => {
		const extra = extraWithMeta({ [CONVERSATION_ID_META_KEY]: 'conversation-1' })
		expect(resolveConversationId(extra)).toBe('conversation-1')
	})

	it('falls back to the host-process key when _meta is absent entirely', () => {
		expect(resolveConversationId(extraWithMeta(undefined))).toBe(HOST_PROCESS_KEY)
	})

	it('falls back to the host-process key when _meta does not carry the key', () => {
		expect(resolveConversationId(extraWithMeta({ progressToken: 'abc' }))).toBe(HOST_PROCESS_KEY)
	})

	it('falls back to the host-process key for a non-string value under the key', () => {
		expect(resolveConversationId(extraWithMeta({ [CONVERSATION_ID_META_KEY]: 42 }))).toBe(HOST_PROCESS_KEY)
	})

	it('falls back to the host-process key for an empty or blank string', () => {
		expect(resolveConversationId(extraWithMeta({ [CONVERSATION_ID_META_KEY]: '' }))).toBe(HOST_PROCESS_KEY)
		expect(resolveConversationId(extraWithMeta({ [CONVERSATION_ID_META_KEY]: '   ' }))).toBe(HOST_PROCESS_KEY)
	})

	it('never returns the bare prefix, so an id is always a real, non-empty key', () => {
		expect(resolveConversationId(extraWithMeta(undefined))).not.toBe(HOST_PROCESS_KEY_PREFIX)
	})
})
