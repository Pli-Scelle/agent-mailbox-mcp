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
 * to do so as of this writing -- that verification belongs to this
 * package's own compatibility testing across real agentic clients, not to
 * its unit test suite.
 *
 * The practical consequence, spelled out rather than glossed over: for any
 * client that does not populate this key, `resolveConversationId` always
 * returns `undefined`, which `elicitation-gate.ts` treats as "no
 * exploitable identifier" -- the first of the safe-default cases,
 * systematic elicitation on every `send`/`purge` that follows a `read`,
 * unconditionally. That is the correct, safe behaviour for an unrecognized
 * host, not a bug: nothing about this convention can make a host LESS safe
 * than having no persisted state at all, it can only ever unlock the
 * frictionless nominal path for a host that opts in.
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
 * Returns a non-empty conversation id, or `undefined` if this call carries
 * none this package recognizes. Never throws: a malformed `_meta` value
 * (wrong type, empty string) is exactly as unusable as a missing one, and
 * both fall into the "no exploitable identifier" case.
 */
export function resolveConversationId(extra: ToolRequestExtra): string | undefined {
	const meta = extra._meta as Record<string, unknown> | undefined
	const candidate = meta?.[CONVERSATION_ID_META_KEY]
	return typeof candidate === 'string' && candidate.trim().length > 0 ? candidate : undefined
}
