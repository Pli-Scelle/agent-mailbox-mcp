/**
 * The interactive "client half" of OAuth 2.1 authorization_code + PKCE:
 * this connector never sees a password, it only ever drives a browser to
 * the authorization server's own login page, reusing the same login
 * pages the backend already presents to human users, and waits for the
 * redirect. For a machine with no browser to open, `device-flow.ts` is
 * the other half this backend supports instead.
 */
import {
	type Configuration,
	authorizationCodeGrant,
	buildAuthorizationUrl,
	calculatePKCECodeChallenge,
	randomPKCECodeVerifier,
	randomState,
} from 'openid-client'
import { awaitAuthorizationCallback } from './loopback-callback-server.js'
import { openInSystemBrowser } from './open-browser.js'
import { AGENT_MAILBOX_OAUTH_SCOPE, agentMailboxResourceIdentifier } from './scopes.js'
import { toTokenRecord, writeTokenRecord } from './token-store.js'

const AUTHORIZATION_TIMEOUT_MS = 5 * 60 * 1000

export interface RunAuthorizationCodeLoginParams {
	configuration: Configuration
	redirectUri: string
	/** Called with the URL the human must open, printed regardless of whether the system browser opens automatically. */
	onAuthorizationUrl: (url: URL) => void
}

export async function runAuthorizationCodeLogin(params: RunAuthorizationCodeLoginParams): Promise<void> {
	const port = Number(new URL(params.redirectUri).port)
	if (!Number.isInteger(port) || port <= 0) {
		throw new Error(`Registered redirect URI "${params.redirectUri}" has no usable port.`)
	}

	const codeVerifier = randomPKCECodeVerifier()
	const codeChallenge = await calculatePKCECodeChallenge(codeVerifier)
	const state = randomState()

	const authorizationUrl = buildAuthorizationUrl(params.configuration, {
		redirect_uri: params.redirectUri,
		scope: AGENT_MAILBOX_OAUTH_SCOPE,
		resource: agentMailboxResourceIdentifier(),
		code_challenge: codeChallenge,
		code_challenge_method: 'S256',
		state,
	})

	params.onAuthorizationUrl(authorizationUrl)
	openInSystemBrowser(authorizationUrl.toString())

	const callbackPromise = awaitAuthorizationCallback({ port, timeoutMs: AUTHORIZATION_TIMEOUT_MS })
	const callbackUrl = await callbackPromise

	const tokens = await authorizationCodeGrant(params.configuration, callbackUrl, {
		expectedState: state,
		pkceCodeVerifier: codeVerifier,
	})

	await writeTokenRecord(toTokenRecord(tokens, AGENT_MAILBOX_OAUTH_SCOPE))
}
