/**
 * RFC 8628 device authorization grant: for a machine that cannot open a
 * local browser (a remote shell, a headless container running the
 * agentic host). The human completes the authorization step on a
 * SEPARATE device that does have a browser, entering the short
 * `user_code` this connector prints, while this process polls the token
 * endpoint until that finishes.
 *
 * `pollDeviceAuthorizationGrant` (openid-client@6.8.4, verified at
 * `build/index.js`) already implements the full poll loop internally
 * (`authorization_pending`, `slow_down`, `Retry-After`, and the
 * `expires_in`-derived timeout), so this file is orchestration only, no
 * polling logic of its own to get subtly wrong.
 */
import { type Configuration, initiateDeviceAuthorization, pollDeviceAuthorizationGrant } from 'openid-client'
import { AGENT_MAILBOX_OAUTH_SCOPE, agentMailboxResourceIdentifier } from './scopes.js'
import { toTokenRecord, writeTokenRecord } from './token-store.js'

export interface RunDeviceLoginParams {
	configuration: Configuration
	/** Called once the human-facing verification URL/code are known, before polling starts. */
	onVerificationPrompt: (prompt: {
		verificationUri: string
		verificationUriComplete: string | undefined
		userCode: string
	}) => void
}

export async function runDeviceLogin(params: RunDeviceLoginParams): Promise<void> {
	const deviceAuthorization = await initiateDeviceAuthorization(params.configuration, {
		scope: AGENT_MAILBOX_OAUTH_SCOPE,
		resource: agentMailboxResourceIdentifier(),
	})

	params.onVerificationPrompt({
		verificationUri: deviceAuthorization.verification_uri,
		verificationUriComplete: deviceAuthorization.verification_uri_complete,
		userCode: deviceAuthorization.user_code,
	})

	const tokens = await pollDeviceAuthorizationGrant(params.configuration, deviceAuthorization)

	await writeTokenRecord(toTokenRecord(tokens, AGENT_MAILBOX_OAUTH_SCOPE))
}
