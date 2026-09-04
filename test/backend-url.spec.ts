import { afterEach, describe, expect, it } from 'vitest'
import { resolveBackendUrl } from '../src/config/backend-url.js'

const ENV_VAR = 'AISCELLE_BACKEND_URL'

describe('resolveBackendUrl', () => {
	afterEach(() => {
		delete process.env[ENV_VAR]
	})

	it('defaults to the production API origin', () => {
		expect(resolveBackendUrl().toString()).toBe('https://api.pliscelle.com/')
	})

	it('honours an https override', () => {
		process.env[ENV_VAR] = 'https://api.preprod.pliscelle.com'

		expect(resolveBackendUrl().toString()).toBe('https://api.preprod.pliscelle.com/')
	})

	it('allows plain http on loopback, for local development', () => {
		process.env[ENV_VAR] = 'http://127.0.0.1:3333'

		expect(resolveBackendUrl().toString()).toBe('http://127.0.0.1:3333/')
	})

	it('allows plain http on localhost too', () => {
		process.env[ENV_VAR] = 'http://localhost:3333'

		expect(resolveBackendUrl().toString()).toBe('http://localhost:3333/')
	})

	it('rejects plain http on a non-loopback host', () => {
		process.env[ENV_VAR] = 'http://api.pliscelle.com'

		expect(() => resolveBackendUrl()).toThrow(/must use https/)
	})

	it('rejects a malformed URL with an actionable message', () => {
		process.env[ENV_VAR] = 'not a url'

		expect(() => resolveBackendUrl()).toThrow(/not a valid URL/)
	})

	it('ignores an override that is only whitespace', () => {
		process.env[ENV_VAR] = '   '

		expect(resolveBackendUrl().toString()).toBe('https://api.pliscelle.com/')
	})
})
