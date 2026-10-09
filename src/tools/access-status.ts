/**
 * `access_status` answers the one question no other tool can answer once
 * this device's AIScelle access is gone: is the mailbox actually empty, or
 * is this device simply unable to see it anymore? (issue #984). Every
 * other tool routes a lost session through `api/mailbox-client.ts`'s
 * `authorizedFetch`, which throws before making any HTTP call at all, so
 * an agent that only reads a failed tool call's error text still has to
 * infer what happened. This tool calls `ensureValidSession` directly and
 * turns the one recoverable failure mode (a definitive OAuth grant error
 * recorded by `oauth/ensure-valid-session.ts`) into a structured answer
 * instead of a thrown error, so an agent can check its own access before
 * acting on what looks like an empty inbox.
 *
 * Any OTHER failure (no session at all, or a transitory refresh still
 * backed off) is left to propagate as an ordinary tool error, the same way
 * every other tool already surfaces `NoSessionError`/`RefreshBackedOffError`:
 * both already carry a clear, actionable message of their own, and this
 * tool exists to add a structured shape for the one case
 * (`AccessLostError`) that DOES need to be presented as a stable, queryable
 * status rather than a fresh error text each time.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { cliCommand } from '../config/cli-invocation.js'
import { AccessLostError, ensureValidSession } from '../oauth/ensure-valid-session.js'

const accessStatusOutputShape = {
	status: z.enum(['valid', 'lost']),
	reason: z.string().optional(),
	lostSince: z.string().optional(),
	repairCommand: z.string().optional(),
}

export function registerAccessStatusTool(server: McpServer): void {
	server.registerTool(
		'access_status',
		{
			title: 'AIScelle access status',
			description:
				'Reports whether this device still has a valid AIScelle session. Call this first when another AIScelle tool fails or the inbox looks unexpectedly empty, before concluding there is no mail: a lost session and an empty mailbox are not the same thing.',
			inputSchema: {},
			outputSchema: accessStatusOutputShape,
			annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
		},
		async () => {
			try {
				await ensureValidSession()
				return {
					content: [{ type: 'text', text: 'AIScelle access is valid.' }],
					structuredContent: { status: 'valid' as const },
				}
			} catch (error) {
				if (error instanceof AccessLostError) {
					const structuredContent = {
						status: 'lost' as const,
						reason: error.reason,
						lostSince: error.since,
						repairCommand: cliCommand('login'),
					}
					return { content: [{ type: 'text', text: error.message }], structuredContent }
				}
				throw error
			}
		},
	)
}
