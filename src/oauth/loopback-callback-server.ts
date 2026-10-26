/**
 * The redirect target for the authorization-code flow (RFC 8252 native-app
 * loopback pattern): binds exactly the port this device's client record
 * registered (client-record.ts), waits for the single callback request the
 * browser makes after the human approves or denies consent, resolves with
 * the full callback URL `authorization-code-flow.ts` hands to
 * `openid-client`'s `authorizationCodeGrant`, then closes. Any other local
 * process can reach the port, so a request whose `state` is not the one this
 * login issued is answered 400 and the server keeps waiting: it cannot end
 * the login early. This is not a long-lived server: it ends with the first
 * matching callback or at the timeout.
 */
import { type Server, createServer } from 'node:http'
import { cliCommand } from '../config/cli-invocation.js'

export interface AwaitCallbackParams {
	port: number
	/** Milliseconds to wait for the human to complete the browser step. */
	timeoutMs: number
	/** The `state` of the authorization request: only a callback that carries it ends the wait. */
	expectedState: string
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

			if (requestUrl.searchParams.get('state') !== params.expectedState) {
				response.writeHead(400).end()
				return
			}

			response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
			response.end(
				'<!doctype html><html><body><p>Pli Scellé : vous pouvez fermer cet onglet et revenir à votre terminal.</p></body></html>',
			)

			clearTimeout(timer)
			server.close()
			resolve(requestUrl)
		})

		const timer = setTimeout(() => {
			server.close()
			reject(
				new Error(
					`Délai dépassé en attendant l'autorisation dans le navigateur (${Math.round(params.timeoutMs / 1000)} s). Relancez \`${cliCommand('login')}\`, ou, si ce terminal est sur une machine distante, lancez plutôt \`${cliCommand('login')} --device\` : il n'a pas besoin de navigateur sur cette machine.`,
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
