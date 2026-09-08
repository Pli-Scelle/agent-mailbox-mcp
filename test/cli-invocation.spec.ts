import { readFile, readdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const PACKAGE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..')
const SRC_DIR = join(PACKAGE_DIR, 'src')
const README = join(PACKAGE_DIR, 'README.md')

/**
 * The bare `pliscelle-mcp <subcommand>` form is what stranded a user on
 * 2026-08-30: `pliscelle-mcp` is not on anyone's PATH unless they installed
 * this package globally themselves, since the only documented install path
 * is `npx @pliscelle/agent-mailbox-mcp` (README.md). Every human-facing
 * message must go through `cliCommand`/`CLI_INVOCATION`
 * (config/cli-invocation.ts) instead of spelling the bare binary out.
 *
 * A doc comment line (starting with `*` or `//`, once trimmed) naming a
 * subcommand as a call-site reference -- "`pair`: the human-run half of
 * device registration", or a docblock quoting the exact broken message
 * found in production -- is not a message a human reads at runtime, so it
 * is not flagged.
 */
const NAKED_INVOCATION = /pliscelle-mcp\s+(pair|login|ratify|policy)\b/

async function collectTypeScriptFiles(dir: string): Promise<Array<string>> {
	const entries = await readdir(dir, { withFileTypes: true })
	const files: Array<string> = []
	for (const entry of entries) {
		const fullPath = join(dir, entry.name)
		if (entry.isDirectory()) {
			files.push(...(await collectTypeScriptFiles(fullPath)))
		} else if (entry.isFile() && entry.name.endsWith('.ts')) {
			files.push(fullPath)
		}
	}
	return files
}

function isCommentLine(line: string): boolean {
	const trimmed = line.trim()
	return trimmed.startsWith('*') || trimmed.startsWith('/**') || trimmed.startsWith('//')
}

describe('no source file spells out an unrunnable bare pliscelle-mcp invocation', () => {
	it('flags every non-comment occurrence of `pliscelle-mcp <subcommand>`', async () => {
		const files = await collectTypeScriptFiles(SRC_DIR)
		const violations: Array<string> = []

		for (const file of files) {
			const content = await readFile(file, 'utf8')
			const lines = content.split('\n')
			lines.forEach((line, index) => {
				if (NAKED_INVOCATION.test(line) && !isCommentLine(line)) {
					violations.push(`${file}:${index + 1}: ${line.trim()}`)
				}
			})
		}

		expect(violations).toEqual([])
	})

	/**
	 * The README is the only instruction sheet a new user reads before
	 * running anything, so a bare invocation there costs exactly what it cost
	 * in production: a command that does not exist, at the first step. It
	 * ships inside the published package, which is why this guard covers it
	 * and stops at the package boundary; the repository's own French docs are
	 * outside what npm distributes and are reviewed by hand.
	 */
	it('flags a bare invocation in the README, the sheet a new user follows', async () => {
		const content = await readFile(README, 'utf8')
		const violations = content
			.split('\n')
			.map((line, index) => ({ line, number: index + 1 }))
			.filter(({ line }) => NAKED_INVOCATION.test(line))
			.map(({ line, number }) => `README.md:${number}: ${line.trim()}`)

		expect(violations).toEqual([])
	})
})
