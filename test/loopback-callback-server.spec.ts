import { describe, expect, it } from 'vitest'
import { awaitAuthorizationCallback } from '../src/oauth/loopback-callback-server.js'
import { pickFreeLoopbackPort } from '../src/oauth/loopback-port.js'

const STATE = 'state-of-this-login'

async function waitUntilListening(port: number): Promise<void> {
	for (let attempt = 0; attempt < 50; attempt++) {
		try {
			await fetch(`http://127.0.0.1:${port}/ready-probe`)
			return
		} catch {
			await new Promise((resolve) => setTimeout(resolve, 20))
		}
	}
	throw new Error('the callback server never listened')
}

describe('awaitAuthorizationCallback', () => {
	it('answers 400 to a callback without the expected state and keeps waiting for the real one', async () => {
		const port = await pickFreeLoopbackPort()
		const callback = awaitAuthorizationCallback({ port, timeoutMs: 5_000, expectedState: STATE })
		await waitUntilListening(port)

		const withoutState = await fetch(`http://127.0.0.1:${port}/callback?code=forged`)
		expect(withoutState.status).toBe(400)
		const wrongState = await fetch(`http://127.0.0.1:${port}/callback?code=forged&state=other`)
		expect(wrongState.status).toBe(400)
		const genuine = await fetch(`http://127.0.0.1:${port}/callback?code=real&state=${STATE}`)
		expect(genuine.status).toBe(200)
		const url = await callback
		expect(url.searchParams.get('code')).toBe('real')
	})

	it('hands over a denied consent too, since the authorization server echoes the state on errors', async () => {
		const port = await pickFreeLoopbackPort()
		const callback = awaitAuthorizationCallback({ port, timeoutMs: 5_000, expectedState: STATE })
		await waitUntilListening(port)

		await fetch(`http://127.0.0.1:${port}/callback?error=access_denied&state=${STATE}`)

		const url = await callback
		expect(url.searchParams.get('error')).toBe('access_denied')
	})
})
