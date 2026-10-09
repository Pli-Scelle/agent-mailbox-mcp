import { describe, expect, it } from 'vitest'
import { serverMessageOf } from '../src/oauth/pairing-registration.js'

/**
 * `pair` is the very first command a user ever runs, and the failure it hits
 * most often is a pairing code that expired or was already used. The server
 * says exactly that; `openid-client` reports "server responded with an error
 * in the response body" and buries the explanation. These pin down the
 * digging, because a user who cannot tell an expired code from an outage
 * retries the wrong thing until the code burns.
 */
describe('serverMessageOf', () => {
	it('reads the message the server sent as a JSON body', () => {
		const error = { response: { body: { message: 'The pairing code is invalid, expired, or has been revoked.' } } }

		expect(serverMessageOf(error)).toBe('The pairing code is invalid, expired, or has been revoked.')
	})

	it('reads an OAuth error_description when that is what came back', () => {
		expect(serverMessageOf({ body: { error_description: 'invalid initial access token' } })).toBe(
			'invalid initial access token',
		)
	})

	it('reads a plain text body', () => {
		expect(serverMessageOf({ response: { body: '  Service Unavailable  ' } })).toBe('Service Unavailable')
	})

	it('follows the cause chain, since fetch failures arrive wrapped', () => {
		const error = new Error('outer', { cause: { body: { message: 'nested explanation' } } })

		expect(serverMessageOf(error)).toBe('nested explanation')
	})

	it('returns undefined rather than inventing a diagnosis', () => {
		expect(serverMessageOf(new Error('network unreachable'))).toBeUndefined()
		expect(serverMessageOf({ response: { body: {} } })).toBeUndefined()
		expect(serverMessageOf({ response: { body: '   ' } })).toBeUndefined()
		expect(serverMessageOf(null)).toBeUndefined()
		expect(serverMessageOf('a string')).toBeUndefined()
	})
})
