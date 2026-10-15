/**
 * Unattended mode: declared once, at launch, by whoever wrote this
 * connector's entry in the host's MCP configuration. That placement IS the
 * security argument, and it is the same one `policy/policy-toggle.ts` makes
 * for the anti-injection kill switch: editing a launch configuration is an
 * act a human performs outside this process, on a file no message this
 * connector ever carries can reach. Were this mode an MCP tool, or a value
 * read back from the backend, an injected message would only have to ask
 * for it to be turned on, and the confirmation this mode replaces would
 * have handed an attacker the means to remove itself. It is never exposed
 * as a tool, and never written to disk by this package.
 *
 * Off unless explicitly declared, and never inferred from anything else: an
 * unrecognized environment value reads as off, the direction that keeps a
 * human in the loop. The environment variable exists for hosts that launch
 * a command line they do not let their user extend with arguments; the flag
 * is the documented form.
 */
export const UNATTENDED_FLAG = '--unattended'

const UNATTENDED_ENV_VAR = 'PLISCELLE_MCP_UNATTENDED'

/**
 * Carried from `cli/index.ts` down to the two tools that pass through
 * `elicitation/elicitation-gate.ts`, by explicit parameter rather than
 * module state: the mode is fixed for the life of the process, and a
 * parameter makes that visible at every call site that depends on it.
 */
export type RuntimeOptions = { unattended: boolean }

export function resolveUnattendedMode(argv: Array<string>, env: NodeJS.ProcessEnv): boolean {
	if (argv.includes(UNATTENDED_FLAG)) return true
	const declared = env[UNATTENDED_ENV_VAR]
	return declared === '1' || declared === 'true'
}
