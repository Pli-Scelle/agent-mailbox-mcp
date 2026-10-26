/**
 * `pliscelle-mcp ratify`, the human-run command: ratifying a correspondent
 * is deliberately not a tool and never will be: if ratification were a
 * tool, an injected message could ask the agent to ratify the attacker's
 * own correspondent. Deliberately NOT wired into `tools/register-tools.ts`
 * or anything the running MCP server exposes over stdio: this module is
 * only ever reached from `cli/ratify.ts`, itself only reached from
 * `cli/index.ts`'s subcommand dispatch, the same channel `pair`/`login`
 * use, never the tool channel an agent can call.
 *
 * What this does NOT guarantee: the command checks no terminal, so an
 * agent that can run a shell command can run it, with the confirmations
 * piped on stdin. AIScellé targets autonomous agents, which must be able
 * to ratify (decision of 16/10/2026). The guarantee is that ratification
 * is not a tool call; whether an agent may run a shell is the host's
 * permission rule, not this package's.
 *
 * Three requirements, all enforced here rather than left to the caller's
 * judgment:
 *   - Always show the full address and the key fingerprint, never the
 *     label alone: `printSenderForConfirmation` below.
 *   - For a ratification at `instruction` level, require an additional
 *     explicit confirmation: a typed confirmation string rather than a
 *     `--yes` flag, never skippable.
 *   - Recommend verifying the fingerprint through an independent channel:
 *     the prompt text says so.
 */
import { createInterface } from 'node:readline/promises'
import { fetchSenderPage } from '../api/mailbox-client.js'
import { cliCommand } from '../config/cli-invocation.js'
import { fingerprintPublicKey } from '../crypto/envelope-crypto.js'
import {
	DuplicateAllowlistKeyError,
	ShownKeyMismatchError,
	markRatifiedLocally,
	readAllowlist,
} from './allowlist-store.js'
import { reconcileLocalAllowlistWithServer } from './reconcile.js'

export class RatificationAbortedError extends Error {
	constructor(reason: string) {
		super(`Ratification abandonnée : ${reason}`)
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
	console.log('Vous allez ratifier ce correspondant sur CET appareil :')
	console.log(`  Libellé (choisi par celui qui l'a ajouté, ne prouve rien) : ${sender.label}`)
	console.log(`  Adresse : ${sender.senderAddress}`)
	console.log(`  Empreinte de la clé (SHA-256) : ${decodeFingerprint(sender.senderPublicKeyEd25519)}`)
	console.log(`  Niveau de confiance configuré côté serveur : ${sender.trustLevel}`)
	console.log(
		"Vérifiez l'adresse et l'empreinte par un canal indépendant de cette application (un appel, un message direct) avant de continuer.",
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
			console.log('Aucun correspondant non ratifié connu de cet appareil.')
			return
		}
		console.log(
			`Correspondants non ratifiés (lancez \`${cliCommand('ratify --sender-id <id>')}\` sur l'un d'eux) :`,
		)
		for (const entry of unratified) {
			console.log(`  ${entry.serverSenderId}  ${entry.label}  ${entry.address}  trust=${entry.trustLevel}`)
		}
		return
	}

	if (!params.senderId) {
		throw new RatificationAbortedError('aucun --sender-id donné ; lancez avec --list pour voir les candidats')
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
		throw new RatificationAbortedError(`aucun correspondant d'identifiant ${params.senderId} sur le serveur`)
	}
	if (!target.isActive) {
		throw new RatificationAbortedError(
			`le correspondant ${params.senderId} n'est pas actif côté serveur ; rien à ratifier`,
		)
	}

	printSenderForConfirmation(target)

	if (target.trustLevel === 'instruction') {
		const answer = await promptLine(
			"Ceci accorde la confiance de niveau INSTRUCTION : les messages de cette clé peuvent diriger l'action de votre agent. Tapez RATIFY pour continuer : ",
		)
		if (answer !== 'RATIFY') {
			throw new RatificationAbortedError(
				'la confirmation du niveau instruction n\'a pas été donnée (texte exact attendu : "RATIFY")',
			)
		}
	} else if (!params.yes) {
		const answer = await promptLine('Ratifier ce correspondant au niveau données ? [o/N] ')
		if (!['o', 'y'].includes(answer.toLowerCase())) {
			throw new RatificationAbortedError('confirmation refusée')
		}
	}

	try {
		await markRatifiedLocally(target.id, target.trustLevel, target.senderPublicKeyEd25519)
	} catch (error) {
		if (error instanceof DuplicateAllowlistKeyError || error instanceof ShownKeyMismatchError) {
			throw new RatificationAbortedError(error.message)
		}
		throw error
	}

	console.log(`${target.label} (${target.senderAddress}) ratifié sur cet appareil.`)
}
