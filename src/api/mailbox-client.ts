/**
 * HTTP client for the mailbox API proposed in `wire-types.ts`. Every six-
 * tool handler (tools/*.ts), the resource handler (resources/sensitive-
 * message-resource.ts), and the presence heartbeat (server/heartbeat.ts)
 * call through here, never `fetch` directly, so the version header
 * (`version/backend-client.ts`), the bearer token, and response validation
 * are each applied exactly once.
 *
 * Token freshness: `ensureValidSession` (oauth/ensure-valid-session.ts) is
 * called before every request here rather than once at process startup.
 * `oauth/token-store.ts` had already flagged this exact gap: the
 * "refresh transparently mid-session" behaviour belongs to whichever piece
 * of code adds the first tool that calls the mailbox API -- this file is
 * that piece. The check is cheap (a local file read plus an expiry
 * comparison; only an actually-expiring token triggers a network refresh
 * call), so paying it on every call is preferable to a `send`/`purge`
 * failing deep into an MCP tool invocation with a stale token and no
 * retry.
 */
import { z } from 'zod'
import { resolveBackendUrl } from '../config/backend-url.js'
import { ensureValidSession } from '../oauth/ensure-valid-session.js'
import { fetchBackend } from '../version/backend-client.js'
import {
	type DepositRequest,
	type DepositResponse,
	type HeartbeatRequest,
	type LinkIdentityRequest,
	type LinkIdentityResponse,
	type LookupAddressResponse,
	type MessageDetailResponse,
	type MessageListResponse,
	type PaginationRequest,
	type SenderListResponse,
	depositResponseSchema,
	linkIdentityResponseSchema,
	lookupAddressResponseSchema,
	messageDetailResponseSchema,
	messageListResponseSchema,
	senderListResponseSchema,
} from './wire-types.js'

/**
 * The server answers every deposit refusal, and every authentication
 * refusal, with one indifferentiated message. This client mirrors that
 * doctrine on purpose: it exposes the HTTP status and the single opaque
 * message the server sent, never attempts to infer or expose a
 * finer-grained reason (mailbox full vs. sender unauthorized vs. invalid
 * signature are indistinguishable by design) -- a caller in this package
 * that branched on response content to guess a refusal reason would be
 * rebuilding, on the client, exactly the side channel the server
 * deliberately closes.
 */
export class AgentMailboxApiError extends Error {
	readonly status: number

	constructor(status: number, message: string) {
		super(message)
		this.name = 'AgentMailboxApiError'
		this.status = status
	}
}

async function authorizedFetch(path: string, init: RequestInit = {}): Promise<Response> {
	const session = await ensureValidSession()
	const url = new URL(path, resolveBackendUrl())
	const headers = new Headers(init.headers)
	headers.set('authorization', `Bearer ${session.accessToken}`)
	if (init.body !== undefined && !headers.has('content-type')) {
		headers.set('content-type', 'application/json')
	}
	return fetchBackend(url, { ...init, headers })
}

async function parseJsonOrThrow<T>(response: Response, schema: z.ZodType<T>): Promise<T> {
	if (!response.ok) {
		// Best-effort message extraction for the human/agent-facing error text;
		// the doctrine above is about never BRANCHING on it, reading it for
		// display is fine (it is already the indifferentiated message).
		let message = `AIScelle API request failed (${response.status})`
		try {
			const body = (await response.clone().json()) as { message?: string }
			if (typeof body.message === 'string') message = body.message
		} catch {
			// Non-JSON or empty body: keep the generic message.
		}
		throw new AgentMailboxApiError(response.status, message)
	}

	const body: unknown = await response.json()
	const parsed = schema.safeParse(body)
	if (!parsed.success) {
		throw new Error(
			`AIScelle API returned a response that does not match the expected shape: ${parsed.error.message}`,
		)
	}
	return parsed.data
}

function paginationQuery(pagination: PaginationRequest | undefined): string {
	const params = new URLSearchParams()
	if (pagination?.cursor) params.set('cursor', pagination.cursor)
	params.set('limit', String(pagination?.limit ?? 20))
	return params.toString()
}

/** `inbox` and `search` (tools/inbox.ts, tools/search.ts) both page through here; `search` filters client-side after decrypting. */
export async function fetchMessagePage(pagination?: PaginationRequest): Promise<MessageListResponse> {
	const response = await authorizedFetch(`/agent-mailbox/messages?${paginationQuery(pagination)}`)
	return parseJsonOrThrow(response, messageListResponseSchema)
}

/**
 * `tools/pending-count.ts`'s single call site: `limit: 0` asks for the
 * count-only shape of the same endpoint without spending a
 * body-decryption pass on any header this caller will not use.
 */
export async function fetchPendingCount(): Promise<number> {
	const response = await authorizedFetch(`/agent-mailbox/messages?${paginationQuery({ limit: 1 })}`)
	const parsed = await parseJsonOrThrow(response, messageListResponseSchema)
	return parsed.pendingCount
}

/** `read` (tools/read.ts) and the sensitive-content resource handler both call this by message id. */
export async function fetchMessage(messageId: string): Promise<MessageDetailResponse> {
	const response = await authorizedFetch(`/agent-mailbox/messages/${encodeURIComponent(messageId)}`)
	return parseJsonOrThrow(response, messageDetailResponseSchema)
}

/** `send` (tools/send.ts). */
export async function depositMessage(request: DepositRequest): Promise<DepositResponse> {
	const response = await authorizedFetch('/agent-mailbox/messages', {
		method: 'POST',
		body: JSON.stringify(request),
	})
	return parseJsonOrThrow(response, depositResponseSchema)
}

/** `purge` (tools/purge.ts). Idempotent server-side. */
export async function purgeMessage(messageId: string): Promise<void> {
	const response = await authorizedFetch(`/agent-mailbox/messages/${encodeURIComponent(messageId)}`, {
		method: 'DELETE',
	})
	if (!response.ok) {
		throw new AgentMailboxApiError(
			response.status,
			`Failed to purge AIScelle message ${messageId} (${response.status})`,
		)
	}
}

/** `senders` (tools/senders.ts) and `trust/reconcile.ts`'s heartbeat reconciliation. */
export async function fetchSenderPage(pagination?: PaginationRequest): Promise<SenderListResponse> {
	const response = await authorizedFetch(`/agent-mailbox/senders?${paginationQuery(pagination)}`)
	return parseJsonOrThrow(response, senderListResponseSchema)
}

/**
 * Fetches every sender (active AND inactive) in one pass, following
 * `nextCursor` to completion. `trust/reconcile.ts` needs the full set,
 * inactive entries included, to tell "purged/deactivated since last
 * heartbeat" apart from "just not on this page" -- `reconcileAllowlist
 * Entries` (trust/allowlist-store.ts) drops any local entry whose server
 * counterpart is inactive or simply absent from this result, so a partial
 * page here would wrongly purge entries the caller never got to see. The
 * `senders` tool (tools/senders.ts), by contrast, exposes one page at a
 * time to the agent, per this package's own cursor pagination contract,
 * and must not call this.
 */
export async function fetchAllSenders(): Promise<Array<SenderListResponse['items'][number]>> {
	const all: Array<SenderListResponse['items'][number]> = []
	let cursor: string | undefined
	do {
		const page = await fetchSenderPage({ cursor, limit: 100 })
		all.push(...page.items)
		cursor = page.nextCursor ?? undefined
	} while (cursor)
	return all
}

/** Sent periodically by server/heartbeat.ts. */
export async function sendHeartbeat(request: HeartbeatRequest): Promise<void> {
	const response = await authorizedFetch('/agent-mailbox/devices/heartbeat', {
		method: 'POST',
		body: JSON.stringify(request),
	})
	if (!response.ok) {
		throw new AgentMailboxApiError(response.status, `AIScelle heartbeat failed (${response.status})`)
	}
}

/** `send` (tools/send.ts), to resolve a recipient address into the public key `sealContentKey` needs. See `LookupAddressResponse`'s doc comment. */
export async function lookupRecipientPublicKey(address: string): Promise<LookupAddressResponse> {
	const response = await authorizedFetch(`/agent-mailbox/lookup/${encodeURIComponent(address)}`)
	return parseJsonOrThrow(response, lookupAddressResponseSchema)
}

/** Called lazily the first time this device needs its mailbox linked (crypto/mailbox-identity.ts's caller). */
export async function linkMailboxIdentity(request: LinkIdentityRequest): Promise<LinkIdentityResponse> {
	const response = await authorizedFetch('/agent-mailbox/identity', {
		method: 'PUT',
		body: JSON.stringify(request),
	})
	return parseJsonOrThrow(response, linkIdentityResponseSchema)
}
