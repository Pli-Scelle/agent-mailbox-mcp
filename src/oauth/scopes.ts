/**
 * Mirrors the backend's own `MAILBOX_READ_SCOPE` / `MAILBOX_WRITE_SCOPE` /
 * resource-identifier definitions for the agent mailbox feature. Two
 * separate codebases, one contract: kept as plain string literals here
 * rather than a shared package, since `agent-mailbox-mcp` is the first
 * PUBLIC artifact of this product and must never depend on backend
 * internals, which are not published and never will be.
 * A drift between the two copies would show up immediately as every OAuth
 * call failing with an invalid_scope/invalid_target error, not silently.
 */
import { resolveBackendUrl } from '../config/backend-url.js'

export const MAILBOX_READ_SCOPE = 'mailbox:read'
export const MAILBOX_WRITE_SCOPE = 'mailbox:write'
export const AGENT_MAILBOX_OAUTH_SCOPE = `${MAILBOX_READ_SCOPE} ${MAILBOX_WRITE_SCOPE}`

/** RFC 8707 resource indicator this connector always requests and presents. */
export function agentMailboxResourceIdentifier(): string {
	return new URL('/agent-mailbox', resolveBackendUrl()).toString()
}
