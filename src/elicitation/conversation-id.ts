/**
 * The persisted elicitation state is indexed on a conversation key. The
 * Model Context Protocol has no standardized notion of a conversation id:
 * `RequestMeta` (SDK-verified, `@modelcontextprotocol/sdk@1.30.0`,
 * `types.d.ts`) only ever declares `progressToken` and the task-relation
 * key, and `RequestHandlerExtra.sessionId` is only populated by the
 * Streamable HTTP transport, while this package only ever runs over stdio
 * (`transport/stdio.ts`) and needs a key that survives an MCP *subprocess*
 * restart.
 *
 * The key is therefore the parent process, the agentic client that spawned
 * this stdio subprocess. Measured on 2026-09-08 against a real install, no
 * host populates a `_meta` conversation key, so this package no longer reads
 * one (issue #2069): a branch that no client exercises is untested surface,
 * and it was the only way to reach a cross-identifier case.
 */

/**
 * Key prefix, so a stored record is recognizable as keyed on the host
 * process. The parent process outlives the subprocess restarts
 * `elicitation-store.ts` was built to survive.
 *
 * Its granularity is stated rather than glossed over, because it is NOT a
 * conversation: a host that keeps one application process across several
 * conversations (any desktop client, as opposed to one terminal session per
 * conversation) hands every one of them the same key. A `read` in one
 * conversation therefore arms the gate for the others running under that
 * same host process, for as long as the record lives.
 *
 * That is coarser than a conversation, never finer, and coarser is the safe
 * direction here: it makes the gate ask MORE often, never less. The same
 * reasoning covers a recycled parent pid: an inherited `hasRead: true` arms
 * the gate, it never disarms it, and an inherited `false` is where a brand
 * new key starts anyway.
 */
export const HOST_PROCESS_KEY_PREFIX = 'host-process:'

/**
 * Returns the host-process key, or `undefined` if this process has no usable
 * parent. Never throws.
 */
export function resolveConversationId(): string | undefined {
	const parentPid = process.ppid
	return Number.isInteger(parentPid) && parentPid > 0 ? `${HOST_PROCESS_KEY_PREFIX}${parentPid}` : undefined
}
