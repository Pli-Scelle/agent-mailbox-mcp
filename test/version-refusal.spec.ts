import { describe, expect, it } from 'vitest'
import { PACKAGE_VERSION_HEADER, readVersionRefusal } from '../src/version/version-refusal.js'

describe('readVersionRefusal', () => {
	it('parses a well-formed too_old refusal', async () => {
		const response = new Response(
			JSON.stringify({
				error: 'package_version_rejected',
				reason: 'too_old',
				minVersion: '2.0.0',
				message: 'Upgrade to 2.0.0 or later: npm install -g @pliscelle/agent-mailbox-mcp@latest',
			}),
			{ status: 426, headers: { 'content-type': 'application/json' } },
		)

		const refusal = await readVersionRefusal(response)

		expect(refusal).toEqual({
			reason: 'too_old',
			minVersion: '2.0.0',
			message: 'Upgrade to 2.0.0 or later: npm install -g @pliscelle/agent-mailbox-mcp@latest',
		})
	})

	it('parses a blocked refusal without minVersion', async () => {
		const response = new Response(
			JSON.stringify({
				error: 'package_version_rejected',
				reason: 'blocked',
				message: 'This version was pulled. Install the latest release.',
			}),
			{ status: 426 },
		)

		const refusal = await readVersionRefusal(response)

		expect(refusal).toEqual({
			reason: 'blocked',
			minVersion: undefined,
			message: 'This version was pulled. Install the latest release.',
		})
	})

	it('ignores a 426 with a body that does not match the contract', async () => {
		const response = new Response(JSON.stringify({ some: 'unrelated shape' }), { status: 426 })

		expect(await readVersionRefusal(response)).toBeUndefined()
	})

	it('ignores a non-426 status even with a matching body', async () => {
		const response = new Response(
			JSON.stringify({ error: 'package_version_rejected', reason: 'too_old', message: 'x' }),
			{ status: 403 },
		)

		expect(await readVersionRefusal(response)).toBeUndefined()
	})

	it('ignores a 426 with a non-JSON body instead of throwing', async () => {
		const response = new Response('not json', { status: 426 })

		expect(await readVersionRefusal(response)).toBeUndefined()
	})

	it('exposes the header name this package sends, so the backend contract stays discoverable from one place', () => {
		expect(PACKAGE_VERSION_HEADER).toBe('AIScelle-Package-Version')
	})
})
