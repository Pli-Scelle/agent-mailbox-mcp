/**
 * The local kill switch: it lives in local configuration, for the same
 * reason the policy text itself is embedded rather than fetched. If it
 * lived server-side, an attacker who had taken over the server could
 * disable the protection for every user of this package in one write. So
 * this file, not a server setting, is the only place this connector's copy
 * of the anti-injection sandwich (policy/injection-policy.ts) can be turned
 * off, and turning it off changes nothing for any other install of this
 * package.
 *
 * Enabled by default (a defense that ships disabled defends nothing): a
 * fresh install with no `policy.json` yet, or one with a file this version
 * cannot parse, always reads as enabled, never as disabled. `readJsonState`'s
 * own contract already makes this the natural default -- it returns
 * `undefined` for both "never written" and "fails schema validation", and
 * this module chooses `true` for that `undefined`, deliberately the
 * fail-SAFE direction (an unreadable state file must never silently turn a
 * live defense off).
 *
 * Never exposed as an MCP tool, for the exact same reason local
 * ratification never is either (trust/ratify.ts's own doc comment): if
 * disabling the policy were a tool, an injected message could ask the
 * agent to call it, and the sandwich would have handed an attacker the
 * means to remove itself through the very channel it exists to guard.
 * `cli/policy.ts` is the only writer, a human-run command.
 */
import { join } from 'node:path'
import { z } from 'zod'
import { readJsonState, writeJsonState } from '../config/local-store.js'
import { resolveConfigDir } from '../config/paths.js'

const policyStateFileSchema = z.object({
	enabled: z.boolean(),
})

function policyStatePath(): string {
	return join(resolveConfigDir(), 'policy.json')
}

export async function isPolicyEnabled(): Promise<boolean> {
	const state = await readJsonState(policyStatePath(), policyStateFileSchema)
	return state?.enabled ?? true
}

export async function setPolicyEnabled(enabled: boolean): Promise<void> {
	await writeJsonState(policyStatePath(), { enabled } satisfies z.infer<typeof policyStateFileSchema>)
}
