/**
 * Picks a free loopback port by binding to port 0 (the OS assigns one),
 * reading it back, then releasing it immediately. There is an unavoidable
 * gap between this function returning and the redirect listener
 * (authorization-code-flow.ts) actually binding the same port later:
 * another process on the same machine could in theory grab it in
 * between. That race is accepted, not ignored: it is only ever exercised
 * once, at `pair` time, and if it does lose the race the listener bind in
 * a later `login` fails loudly with `EADDRINUSE` rather than silently
 * doing the wrong thing, so a maintainer sees a clear error instead of a
 * connector that appears to hang.
 */
import { createServer } from 'node:net'

export async function pickFreeLoopbackPort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const server = createServer()
		server.once('error', reject)
		server.listen(0, '127.0.0.1', () => {
			const address = server.address()
			server.close((closeError) => {
				if (closeError) {
					reject(closeError)
					return
				}
				if (!address || typeof address === 'string') {
					reject(new Error('Could not determine a free loopback port (unexpected address shape).'))
					return
				}
				resolve(address.port)
			})
		})
	})
}
