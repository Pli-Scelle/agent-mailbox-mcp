/**
 * The persisted elicitation state is indexed on a conversation identifier
 * supplied by the client. The Model Context Protocol has no standardized
 * notion of a conversation id: `RequestMeta` (SDK-verified,
 * `@modelcontextprotocol/sdk@1.30.0`, `types.d.ts`) only ever declares
 * `progressToken` and the task-relation key, and a grep of the whole SDK
 * turns up no `conversationId`/`sessionId`/`threadId` field anywhere in the
 * protocol types. `RequestHandlerExtra.sessionId` exists on the type, but
 * it is populated by the Streamable HTTP transport for its own multiplexed
 * connections; this package only ever runs over stdio
 * (`transport/stdio.ts`), where the SDK never sets it, and even if it did,
 * the persisted state needs an id that survives an MCP *subprocess*
 * restart, which a fresh stdio connection's own session bookkeeping cannot
 * provide by construction.
 *
 * So, exactly like `version/version-refusal.ts` and `api/wire-types.ts`
 * had to invent a wire contract for a gap left open elsewhere, THIS is
 * this package's own proposal for where a conversation id can come from:
 * the free-form `_meta` object every JSON-RPC request carries
 * (`BaseRequestParamsSchema`, SDK-verified), under the key below, IF the
 * calling agentic host chooses to populate it. No known host is verified
 * to do so as of this writing: that verification belongs to this
 * package's own compatibility testing across real agentic clients, not to
 * its unit test suite.
 *
 * Measured on 2026-09-08 against a real install: no host populates the key,
 * so this convention alone left `resolveConversationId` returning
 * `undefined` on every call, `elicitation-store.ts` never writing a single
 * record, and the gate therefore eliciting on every `send`/`purge` whether
 * or not a `read` had happened. Safe, and unusable. The meta key stays the
 * PREFERRED source, for the day a host adopts it; the host-process fallback
 * below is what actually carries the mechanism until then.
 */
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js'
import type { ServerNotification, ServerRequest } from '@modelcontextprotocol/sdk/types.js'

/**
 * This package's own `_meta` convention, not a protocol standard: see this
 * module's doc comment. Namespaced the way MCP's own reserved `_meta` keys
 * are (e.g. `io.modelcontextprotocol/related-task`), so a host that adopts
 * it cannot collide with an unrelated extension by accident.
 */
export const CONVERSATION_ID_META_KEY = 'com.pliscelle/conversationId'

type ToolRequestExtra = RequestHandlerExtra<ServerRequest, ServerNotification>

/**
 * Fallback key, used whenever the calling host populates no `_meta` key of
 * ours, which, measured on 2026-09-08, is every host there is. The parent
 * process is the agentic client that spawned this stdio subprocess, and it
 * outlives the subprocess restarts `elicitation-store.ts` was built to
 * survive.
 *
 * Its granularity is stated rather than glossed over, because it is NOT a
 * conversation: a host that keeps one application process across several
 * conversations (any desktop client, as opposed to one terminal session per
 * conversation) hands every one of them the same key. A `read` in one
 * conversation therefore arms the gate for the others running under that
 * same host process, for as long as the record lives.
 *
 * That is coarser than a conversation, never finer, and coarser is the safe
 * direction here: it makes the gate ask MORE often, never less. It is also
 * strictly narrower than what this package did before: with no key at all,
 * every single send and purge was gated, read or no read. The same reasoning
 * covers a recycled parent pid: an inherited `hasRead: true` arms the gate,
 * it never disarms it, and an inherited `false` is where a brand new key
 * starts anyway.
 */
export const HOST_PROCESS_KEY_PREFIX = 'host-process:'

function hostProcessKey(): string | undefined {
	const parentPid = process.ppid
	return Number.isInteger(parentPid) && parentPid > 0 ? `${HOST_PROCESS_KEY_PREFIX}${parentPid}` : undefined
}

/**
 * Returns a non-empty conversation id, or `undefined` if this call carries
 * none this package recognizes and this process has no parent to fall back
 * on. Never throws: a malformed `_meta` value (wrong type, empty string) is
 * exactly as unusable as a missing one, and both fall through to the
 * host-process key.
 */
export function resolveConversationId(extra: ToolRequestExtra): string | undefined {
	const meta = extra._meta as Record<string, unknown> | undefined
	const candidate = meta?.[CONVERSATION_ID_META_KEY]
	if (typeof candidate === 'string' && candidate.trim().length > 0) return candidate
	return hostProcessKey()
}
