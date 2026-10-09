import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fetchBackend, openidClientFetch } from '../src/version/backend-client.js'
import { getPackageVersion } from '../src/version/package-version.js'
import { PACKAGE_VERSION_HEADER, PackageVersionRejectedError } from '../src/version/version-refusal.js'

describe('fetchBackend', () => {
	const originalFetch = globalThis.fetch

	afterEach(() => {
		globalThis.fetch = originalFetch
		vi.restoreAllMocks()
	})

	it('attaches its own package version on every request', async () => {
		const capturedHeaders: Array<Headers> = []
		globalThis.fetch = vi.fn((_input, init) => {
			capturedHeaders.push(new Headers(init?.headers))
			return Promise.resolve(new Response('{}', { status: 200 }))
		}) as typeof fetch

		await fetchBackend('https://api.pliscelle.com/agent-mailbox/oauth/token', { method: 'POST' })

		expect(capturedHeaders).toHaveLength(1)
		expect(capturedHeaders[0]!.get(PACKAGE_VERSION_HEADER)).toBe(getPackageVersion())
	})

	it('throws PackageVersionRejectedError instead of returning the raw 426', async () => {
		globalThis.fetch = vi.fn(() =>
			Promise.resolve(
				new Response(
					JSON.stringify({
						error: 'package_version_rejected',
						reason: 'too_old',
						minVersion: '9.9.9',
						message: 'go upgrade',
					}),
					{ status: 426 },
				),
			),
		) as typeof fetch

		await expect(fetchBackend('https://api.pliscelle.com/agent-mailbox/oauth/token')).rejects.toThrow(
			PackageVersionRejectedError,
		)
	})

	it('passes through an ordinary error response untouched', async () => {
		globalThis.fetch = vi.fn(() => Promise.resolve(new Response('{}', { status: 401 }))) as typeof fetch

		const response = await fetchBackend('https://api.pliscelle.com/agent-mailbox/oauth/token')

		expect(response.status).toBe(401)
	})
})

describe('openidClientFetch', () => {
	beforeEach(() => {
		vi.restoreAllMocks()
	})

	it('merges the version header into the plain headers object without dropping existing ones', async () => {
		const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 200 }))

		await openidClientFetch('https://api.pliscelle.com/agent-mailbox/oauth/register', {
			method: 'POST',
			headers: { authorization: 'Bearer some-pairing-code', 'content-type': 'application/json' },
			body: '{}',
		})

		const [, calledInit] = spy.mock.calls[0]!
		const headers = new Headers(calledInit?.headers)
		expect(headers.get('authorization')).toBe('Bearer some-pairing-code')
		expect(headers.get(PACKAGE_VERSION_HEADER)).toBe(getPackageVersion())
	})

	it('surfaces a blocked-version refusal the same way as too_old', async () => {
		vi.spyOn(globalThis, 'fetch').mockResolvedValue(
			new Response(JSON.stringify({ error: 'package_version_rejected', reason: 'blocked', message: 'blocked' }), {
				status: 426,
			}),
		)

		await expect(
			openidClientFetch('https://api.pliscelle.com/agent-mailbox/oauth/register', {
				method: 'POST',
				headers: {},
			}),
		).rejects.toMatchObject({ reason: 'blocked' })
	})
})
