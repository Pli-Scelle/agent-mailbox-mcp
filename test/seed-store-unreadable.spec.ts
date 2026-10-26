import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LocalStateUnreadableError } from '../src/config/local-store.js'
import { resolveConfigDir } from '../src/config/paths.js'
import { ensureMailboxSeed } from '../src/crypto/seed-store.js'

/**
 * A read refused by the system, whoever runs the suite: root reads a file whatever its mode, so a
 * `chmod 000` proves nothing under the CI's root account. The refusal is the one `readFile` raises,
 * with its real code, for the one path a test names; every other read goes to the real module.
 */
const deniedRead = vi.hoisted(() => ({ path: null as string | null }))

vi.mock('node:fs/promises', async (importOriginal) => {
	const actual = await importOriginal<typeof import('node:fs/promises')>()
	const readFile = ((path: Parameters<typeof actual.readFile>[0], ...rest: Array<unknown>) => {
		if (deniedRead.path !== null && String(path) === deniedRead.path) {
			const error: NodeJS.ErrnoException = new Error(`EACCES: permission denied, open '${String(path)}'`)
			error.code = 'EACCES'
			error.errno = -13
			error.syscall = 'open'
			error.path = String(path)
			return Promise.reject(error)
		}
		return (actual.readFile as (...args: Array<unknown>) => Promise<unknown>)(path, ...rest)
	}) as typeof actual.readFile
	return { ...actual, readFile }
})

/**
 * Issue #1936: only a seed file that does not exist yet is a first use. A file that exists but
 * cannot be read, or does not parse, holds this device's mailbox identity: replacing it would make
 * every message sealed to the old key unreadable. It is refused, and left byte for byte as it was.
 */
describe('seed store with an unreadable seed.json', () => {
	let dir: string
	let previousXdg: string | undefined
	let seedPath: string

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), 'pliscelle-mcp-seed-unreadable-'))
		previousXdg = process.env.XDG_CONFIG_HOME
		process.env.XDG_CONFIG_HOME = dir
		await mkdir(resolveConfigDir(), { recursive: true })
		seedPath = join(resolveConfigDir(), 'seed.json')
	})

	afterEach(async () => {
		deniedRead.path = null
		if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME
		else process.env.XDG_CONFIG_HOME = previousXdg
		await rm(dir, { recursive: true, force: true })
	})

	it('refuses a seed.json that is not valid JSON and leaves it untouched', async () => {
		const corrupt = Buffer.from('{"seed": "AAAA", "createdAt": ')
		await writeFile(seedPath, corrupt)

		const outcome = await ensureMailboxSeed().catch((error: Error) => error)

		expect((await readFile(seedPath)).equals(corrupt)).toBe(true)
		expect(outcome).toBeInstanceOf(LocalStateUnreadableError)
		expect((outcome as Error).message).not.toContain('AAAA')
	})

	it('refuses a seed.json it is not allowed to read and leaves it untouched', async () => {
		const original = Buffer.from(
			JSON.stringify({ seed: Buffer.alloc(32, 7).toString('base64'), createdAt: new Date().toISOString() }),
		)
		await writeFile(seedPath, original)
		deniedRead.path = seedPath

		const outcome = await ensureMailboxSeed().catch((error: Error) => error)

		deniedRead.path = null
		expect((await readFile(seedPath)).equals(original)).toBe(true)
		expect(outcome).toBeInstanceOf(LocalStateUnreadableError)
		expect((outcome as Error).message).toContain('EACCES')
	})

	it('still creates a seed on first use, when no seed.json exists', async () => {
		const seed = await ensureMailboxSeed()

		expect(seed).toHaveLength(32)
		expect((await ensureMailboxSeed()).equals(seed)).toBe(true)
	})
})
