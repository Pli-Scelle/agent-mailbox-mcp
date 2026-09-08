/**
 * Sensitive content is served as a resource link, never as embedded
 * content, which leaves the client the decision to materialize the data or
 * not. `tools/read.ts` never returns a sensitive message's plaintext body
 * as inline tool-result content; it returns an MCP `resource_link` content
 * block instead (uri, name, description -- never the decrypted text), and
 * this module is what actually serves that resource's bytes IF the host
 * later calls `resources/read` on it. That "if" is the entire point: a
 * host that never fetches the resource never materializes the body at all.
 *
 * Registered once, at server startup (server/register-agent-mailbox-tools.ts),
 * as a `ResourceTemplate` rather than one static resource per message: the
 * set of pending messages changes constantly and this device has no reason
 * to pre-register or track one URI per message.
 *
 * Wrapped in the same policy sandwich (policy/injection-policy.ts) as
 * `tools/read.ts`'s inline body, for the same reason: this text is exactly
 * as sender-controlled as any other message body, only reached by a
 * different channel.
 *
 * DOES arm the elicitation store (elicitation/elicitation-store.ts), the
 * same way `tools/read.ts` does and for the same reason: serving a
 * decrypted body here IS a read, whatever channel carried it.
 *
 * This file used to argue the opposite, that `tools/read.ts` had
 * necessarily run already because the `resource_link` only exists after
 * that call succeeded. That premise was wrong, and it mattered: this URI
 * is `aiscelle-message://{messageId}` and nothing in it comes from the
 * `read` tool. `tools/inbox.ts` and `tools/search.ts` list the id of every
 * message, sensitive ones included, without ever calling `read`, and an
 * MCP host is free to issue `resources/read` on a URI it built itself.
 * The `takeCachedOpenedMessage(...) ?? fetchMessage(...)` fallback just
 * below is itself the proof: it exists precisely for the case where no
 * `read` preceded this fetch. So the body could be obtained through a path
 * that left `hasRead` false, and the following `send` or `purge` then
 * skipped the elicitation prompt entirely -- defeating the one mechanism
 * in this package (elicitation/elicitation-gate.ts) that does not rely on
 * persuading the model.
 *
 * Arming here can never make a host less safe: a call carrying no
 * conversation id resolves to `undefined`, which is already treated as "no
 * exploitable identifier" and answered with systematic elicitation
 * (see elicitation/conversation-id.ts).
 *
 * Does NOT call `fetchMessage` again when `tools/read.ts` already cached
 * the opened message for this id, correction after review: `GET
 * /agent-mailbox/messages/:id` is the server's own atomic read-count
 * increment, and `tools/read.ts` already paid it once to produce the
 * `resource_link` this handler serves. Re-fetching here would count a
 * SECOND read for what the agent experiences as one, and would make a
 * message deposited with `max_reads: 1` unrecoverable through this exact
 * link. `trust/opened-message-cache.ts` is the in-process (never-disk)
 * bridge for that; only falls back to a fresh, fully-reverified fetch when
 * nothing is cached (process restarted between the two calls, the cache's
 * TTL elapsed, or the link is fetched a second time), which legitimately
 * costs one more read -- an accepted, narrow residual, not a regression
 * against calling `fetchMessage` unconditionally the way this file used to.
 */
import { ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { fetchMessage } from '../api/mailbox-client.js'
import { resolveConversationId } from '../elicitation/conversation-id.js'
import { markConversationRead } from '../elicitation/elicitation-store.js'
import { describeMessageSource, wrapUntrustedContent } from '../policy/injection-policy.js'
import { takeCachedOpenedMessage } from '../trust/opened-message-cache.js'
import { openMessage } from '../trust/resolve-trust.js'

export const SENSITIVE_MESSAGE_URI_TEMPLATE = 'aiscelle-message://{messageId}'

export function sensitiveMessageResourceUri(messageId: string): string {
	return `aiscelle-message://${messageId}`
}

export function registerSensitiveMessageResource(server: McpServer): void {
	server.registerResource(
		'aiscelle-message',
		new ResourceTemplate(SENSITIVE_MESSAGE_URI_TEMPLATE, {
			// No enumeration: nothing here ever lists message content for
			// browsing outside the `inbox`/`search` tools' own header-only
			// view.
			list: undefined,
		}),
		{
			title: 'AIScelle message content',
			description:
				'The decrypted body of one AIScelle message, fetched and verified on this device only when explicitly read.',
		},
		async (uri, variables, extra) => {
			const messageId = Array.isArray(variables.messageId) ? variables.messageId[0] : variables.messageId
			if (!messageId) {
				throw new Error(`Malformed AIScelle resource URI: ${uri.toString()}`)
			}

			// Prefer the entry `tools/read.ts` cached for this same logical
			// read (see this module's doc comment on why re-fetching would
			// double-count against `max_reads`). It was already verified and
			// decrypted through `openMessage` there, under the exact same
			// verification rule this file would otherwise re-run, so nothing
			// here is trusted without having gone through that check.
			const cached = takeCachedOpenedMessage(messageId)
			const opened = cached ?? (await openMessage(await fetchMessage(messageId)))

			// The read genuinely happened (verified, decrypted) from this
			// point on, exactly as in `tools/read.ts`. Armed after
			// `openMessage` so a rejected message arms nothing: nothing was
			// exposed, so nothing was read.
			const conversationId = resolveConversationId(extra)
			if (conversationId) await markConversationRead(conversationId)

			return {
				contents: [
					{
						uri: uri.toString(),
						mimeType: 'text/plain',
						text: await wrapUntrustedContent(opened.bodyText, describeMessageSource(opened)),
					},
				],
			}
		},
	)
}
