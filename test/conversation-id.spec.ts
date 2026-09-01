import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js'
import type { ServerNotification, ServerRequest } from '@modelcontextprotocol/sdk/types.js'
import { describe, expect, it } from 'vitest'
import { CONVERSATION_ID_META_KEY, resolveConversationId } from '../src/elicitation/conversation-id.js'

type ToolRequestExtra = RequestHandlerExtra<ServerRequest, ServerNotification>

function extraWithMeta(meta: Record<string, unknown> | undefined): ToolRequestExtra {
	return { _meta: meta } as unknown as ToolRequestExtra
}

describe('resolveConversationId', () => {
	it('returns the value under this package’s own _meta key when present', () => {
		const extra = extraWithMeta({ [CONVERSATION_ID_META_KEY]: 'conversation-1' })
		expect(resolveConversationId(extra)).toBe('conversation-1')
	})

	it('returns undefined when _meta is absent entirely', () => {
		expect(resolveConversationId(extraWithMeta(undefined))).toBeUndefined()
	})

	it('returns undefined when _meta does not carry the key', () => {
		expect(resolveConversationId(extraWithMeta({ progressToken: 'abc' }))).toBeUndefined()
	})

	it('returns undefined for a non-string value under the key', () => {
		expect(resolveConversationId(extraWithMeta({ [CONVERSATION_ID_META_KEY]: 42 }))).toBeUndefined()
	})

	it('returns undefined for an empty or blank string', () => {
		expect(resolveConversationId(extraWithMeta({ [CONVERSATION_ID_META_KEY]: '' }))).toBeUndefined()
		expect(resolveConversationId(extraWithMeta({ [CONVERSATION_ID_META_KEY]: '   ' }))).toBeUndefined()
	})
})
