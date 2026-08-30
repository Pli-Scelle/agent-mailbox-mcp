/**
 * `pliscelle-mcp ratify`, the human-run command: ratifying a correspondent
 * is deliberately not a tool and never will be -- if ratification were a
 * tool, an injected message could ask the agent to ratify the attacker's
 * own correspondent. Deliberately NOT wired into `tools/register-tools.ts`
 * or anything the running MCP server exposes over stdio: this module is
 * only ever reached from `cli/ratify.ts`, itself only reached from
 * `cli/index.ts`'s subcommand dispatch, the same channel `pair`/`login`
 * use, never the tool channel an agent can call.
 *
 * Three requirements, all enforced here rather than left to the caller's
 * judgment:
 *   - Always show the full address and the key fingerprint, never the
 *     label alone -- `printSenderForConfirmation` below.
 *   - For a ratification at `instruction` level, require an additional
 *     explicit confirmation -- a typed confirmation string, not a `--yes`
 *     flag a script could pass blindly, and never skippable.
 *   - Recommend verifying the fingerprint through an independent channel
 *     -- the prompt text says so.
 */
import { createInterface } from 'node:readline/promises'
import { fetchSenderPage } from '../api/mailbox-client.js'
import { fingerprintPublicKey } from '../crypto/envelope-crypto.js'
import { DuplicateAllowlistKeyError, markRatifiedLocally, readAllowlist } from './allowlist-store.js'
import { reconcileLocalAllowlistWithServer } from './reconcile.js'

export class RatificationAbortedError extends Error {
	constructor(reason: string) {
		super(`Ratification aborted: ${reason}`)
		this.name = 'RatificationAbortedError'
	}
}

async function promptLine(question: string): Promise<string> {
	const rl = createInterface({ input: process.stdin, output: process.stdout })
	try {
		return (await rl.question(question)).trim()
	} finally {
		rl.close()
	}
}

function decodeFingerprint(publicKeyEd25519Base64: string): string {
	return fingerprintPublicKey(Buffer.from(publicKeyEd25519Base64, 'base64'))
}

function printSenderForConfirmation(sender: {
	senderAddress: string
	senderPublicKeyEd25519: string
	label: string
	trustLevel: 'data' | 'instruction'
}): void {
	console.log('You are about to ratify this correspondent on THIS device:')
	console.log(`  Label (chosen by whoever added it, proves nothing): ${sender.label}`)
	console.log(`  Address: ${sender.senderAddress}`)
	console.log(`  Key fingerprint (SHA-256): ${decodeFingerprint(sender.senderPublicKeyEd25519)}`)
	console.log(`  Trust level configured server-side: ${sender.trustLevel}`)
	console.log(
		'Verify the address and fingerprint against a channel independent of this app (a call, a direct message) before continuing.',
	)
}

export interface RunRatifyCommandParams {
	senderId?: string
	list?: boolean
	/** Skips the plain confirmation prompt for `data`-level sends. Never applies to `instruction` level: see the module doc comment. */
	yes?: boolean
}

export async function runRatifyCommand(params: RunRatifyCommandParams): Promise<void> {
	await reconcileLocalAllowlistWithServer()

	if (params.list) {
		const local = await readAllowlist()
		const unratified = local.filter((entry) => !entry.ratifiedLocally)
		if (unratified.length === 0) {
			console.log('No unratified correspondents known to this device.')
			return
		}
		console.log('Unratified correspondents (run `pliscelle-mcp ratify --sender-id <id>` on one):')
		for (const entry of unratified) {
			console.log(`  ${entry.serverSenderId}  ${entry.label}  ${entry.address}  trust=${entry.trustLevel}`)
		}
		return
	}

	if (!params.senderId) {
		throw new RatificationAbortedError('no --sender-id given; run with --list to see candidates')
	}

	// Re-fetched directly (not from the just-reconciled local mirror) so the
	// confirmation prompt below shows exactly what the server currently
	// reports, even if it changed in the instant between reconcile and this
	// call.
	let target: Awaited<ReturnType<typeof fetchSenderPage>>['items'][number] | undefined
	let cursor: string | undefined
	do {
		const page = await fetchSenderPage({ cursor, limit: 100 })
		target = page.items.find((entry) => entry.id === params.senderId)
		cursor = page.nextCursor ?? undefined
	} while (!target && cursor)

	if (!target) {
		throw new RatificationAbortedError(`no sender with id ${params.senderId} found on the server`)
	}
	if (!target.isActive) {
		throw new RatificationAbortedError(`sender ${params.senderId} is not active server-side; nothing to ratify`)
	}

	printSenderForConfirmation(target)

	if (target.trustLevel === 'instruction') {
		const answer = await promptLine(
			'This grants INSTRUCTION-level trust: messages from this key can direct your agent to act. Type RATIFY to proceed: ',
		)
		if (answer !== 'RATIFY') {
			throw new RatificationAbortedError(
				'instruction-level confirmation was not given (expected exact text "RATIFY")',
			)
		}
	} else if (!params.yes) {
		const answer = await promptLine('Ratify this correspondent as data-level? [y/N] ')
		if (answer.toLowerCase() !== 'y') {
			throw new RatificationAbortedError('confirmation declined')
		}
	}

	try {
		await markRatifiedLocally(target.id)
	} catch (error) {
		if (error instanceof DuplicateAllowlistKeyError) {
			throw new RatificationAbortedError(error.message)
		}
		throw error
	}

	console.log(`Ratified ${target.label} (${target.senderAddress}) on this device.`)
}
