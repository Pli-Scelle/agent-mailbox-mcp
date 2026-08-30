/**
 * The redirect target for the authorization-code flow (RFC 8252 native-app
 * loopback pattern): binds exactly the port this device's client record
 * registered (client-record.ts), waits for the single callback request the
 * browser makes after the human approves or denies consent, resolves with
 * the full callback URL `authorization-code-flow.ts` hands to
 * `openid-client`'s `authorizationCodeGrant`, then closes. One request,
 * one response, one shutdown: this is not a long-lived server.
 */
import { type Server, createServer } from 'node:http'

export interface AwaitCallbackParams {
	port: number
	/** Milliseconds to wait for the human to complete the browser step. */
	timeoutMs: number
}

const CALLBACK_PATH = '/callback'

export async function awaitAuthorizationCallback(params: AwaitCallbackParams): Promise<URL> {
	return new Promise((resolve, reject) => {
		const server: Server = createServer((request, response) => {
			const requestUrl = new URL(request.url ?? '/', `http://127.0.0.1:${params.port}`)
			if (requestUrl.pathname !== CALLBACK_PATH) {
				response.writeHead(404).end()
				return
			}

			response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
			response.end(
				'<!doctype html><html><body><p>Pli Scelle: you can close this tab and return to your terminal.</p></body></html>',
			)

			clearTimeout(timer)
			server.close()
			resolve(requestUrl)
		})

		const timer = setTimeout(() => {
			server.close()
			reject(
				new Error(
					`Timed out waiting for the browser authorization step (${Math.round(params.timeoutMs / 1000)}s). Run \`pliscelle-mcp login\` again.`,
				),
			)
		}, params.timeoutMs)

		server.once('error', (error) => {
			clearTimeout(timer)
			reject(error)
		})

		server.listen(params.port, '127.0.0.1')
	})
}
