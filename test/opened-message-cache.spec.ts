import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
	cacheOpenedSensitiveMessage,
	openedMessageCacheSizeForTests,
	takeCachedOpenedMessage,
} from '../src/trust/opened-message-cache.js'
import type { OpenedMessage } from '../src/trust/resolve-trust.js'

const TTL_MS = 5 * 60 * 1000

function openedMessage(bodyText: string): OpenedMessage {
	return {
		trustLevel: 'data',
		isRatified: true,
		senderAddress: 'sender@example.test',
		senderLabel: 'Sender',
		header: {} as OpenedMessage['header'],
		bodyText,
	}
}

describe('opened-message-cache', () => {
	beforeEach(() => {
		vi.useFakeTimers()
	})

	afterEach(() => {
		vi.clearAllTimers()
		vi.useRealTimers()
	})

	it('drops an entry nobody consumed once its TTL has elapsed', () => {
		const before = openedMessageCacheSizeForTests()
		cacheOpenedSensitiveMessage('never-materialized', openedMessage('secret body'))
		expect(openedMessageCacheSizeForTests()).toBe(before + 1)

		vi.advanceTimersByTime(TTL_MS + 1)

		expect(openedMessageCacheSizeForTests()).toBe(before)
	})

	it('still serves an entry consumed within its TTL, once', () => {
		cacheOpenedSensitiveMessage('materialized', openedMessage('body'))
		vi.advanceTimersByTime(TTL_MS - 1000)

		expect(takeCachedOpenedMessage('materialized')?.bodyText).toBe('body')
		expect(takeCachedOpenedMessage('materialized')).toBeUndefined()
	})

	it('does not let the expiry of a replaced entry drop its replacement', () => {
		cacheOpenedSensitiveMessage('cached-twice', openedMessage('first'))
		vi.advanceTimersByTime(TTL_MS - 1000)
		cacheOpenedSensitiveMessage('cached-twice', openedMessage('second'))

		vi.advanceTimersByTime(2000)

		expect(takeCachedOpenedMessage('cached-twice')?.bodyText).toBe('second')
	})
})
