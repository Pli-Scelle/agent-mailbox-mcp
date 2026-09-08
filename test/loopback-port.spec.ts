import { createServer } from 'node:net'
import { describe, expect, it } from 'vitest'
import { pickFreeLoopbackPort } from '../src/oauth/loopback-port.js'

describe('pickFreeLoopbackPort', () => {
	it('returns a port that can actually be bound on 127.0.0.1', async () => {
		const port = await pickFreeLoopbackPort()

		expect(port).toBeGreaterThan(0)
		expect(port).toBeLessThan(65536)

		await new Promise<void>((resolve, reject) => {
			const server = createServer()
			server.once('error', reject)
			server.listen(port, '127.0.0.1', () => {
				server.close(() => resolve())
			})
		})
	})
})
