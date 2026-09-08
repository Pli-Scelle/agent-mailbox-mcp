/**
 * Public programmatic surface of `@pliscelle/agent-mailbox-mcp`, used by
 * the tool implementations and by this package's own tests. The CLI
 * (`cli/index.ts`) is the product's actual entry point for an end user;
 * this module exists for code that imports the package rather than
 * spawning it.
 */
export { createAgentMailboxServer } from './server/create-server.js'
export { logAgentMailboxEvent, type AgentMailboxLogEvent } from './server/logging.js'
export { runStdioServer } from './transport/stdio.js'

export { getPackageVersion } from './version/package-version.js'
export { fetchBackend, openidClientFetch } from './version/backend-client.js'
export {
	PACKAGE_VERSION_HEADER,
	PackageVersionRejectedError,
	readVersionRefusal,
	type VersionRefusal,
	type VersionRefusalReason,
} from './version/version-refusal.js'

export { resolveBackendUrl } from './config/backend-url.js'

export {
	agentMailboxResourceIdentifier,
	AGENT_MAILBOX_OAUTH_SCOPE,
	MAILBOX_READ_SCOPE,
	MAILBOX_WRITE_SCOPE,
} from './oauth/scopes.js'
export { registerDevice, type RegisterDeviceParams, type RegisterDeviceResult } from './oauth/pairing-registration.js'
export { loadRegisteredConfiguration, type LoadedConfiguration } from './oauth/discovery.js'
export { runAuthorizationCodeLogin } from './oauth/authorization-code-flow.js'
export { runDeviceLogin } from './oauth/device-flow.js'
export { ensureValidSession, NoSessionError, type ValidSession } from './oauth/ensure-valid-session.js'
export {
	readClientRecord,
	requireClientRecord,
	NoClientRegisteredError,
	type ClientRecord,
} from './oauth/client-record.js'
export { readTokenRecord, isTokenRecordExpiring, type TokenRecord } from './oauth/token-store.js'

export { CONVERSATION_ID_META_KEY, resolveConversationId } from './elicitation/conversation-id.js'
export {
	lookupConversationState,
	markConversationRead,
	touchConversationAfterAllowedAction,
	type ConversationLookup,
} from './elicitation/elicitation-store.js'
export {
	evaluateElicitationGate,
	commitAllowedAction,
	type ElicitationGateOutcome,
} from './elicitation/elicitation-gate.js'

export { isPolicyEnabled, setPolicyEnabled } from './policy/policy-toggle.js'
export { INJECTION_POLICY_VERSION, wrapUntrustedContent, describeMessageSource } from './policy/injection-policy.js'
