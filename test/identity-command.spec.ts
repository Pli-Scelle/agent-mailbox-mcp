import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { formatIdentityOutput, runIdentityCommand } from '../src/cli/identity.js'
import { computeMailboxAddress, deriveMailboxKeys, encodeKeyMaterial } from '../src/crypto/envelope-crypto.js'

/**
 * A fixed seed rather than `randomBytes`: this command's output is what a
 * human copies into a correspondent's allowlist, so the test pins the
 * exact bytes it prints for a known input instead of re-deriving the
 * expectation from the same call it is checking.
 *
 * `loadMailboxIdentity` caches per process, so the seed is written before
 * the single test that goes through it and no other test in this file
 * reads a different one.
 */
const SEED_BASE64 = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8='

describe('identity command', () => {
	let dir: string
	let previousXdgConfigHome: string | undefined
	let logSpy: ReturnType<typeof vi.spyOn>

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), 'aiscelle-mcp-identity-test-'))
		previousXdgConfigHome = process.env.XDG_CONFIG_HOME
		process.env.XDG_CONFIG_HOME = dir
		await mkdir(join(dir, 'pliscelle-mcp'), { recursive: true })
		await writeFile(
			join(dir, 'pliscelle-mcp', 'seed.json'),
			JSON.stringify({ seed: SEED_BASE64, createdAt: '2026-08-31T00:00:00.000Z' }),
		)
		logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined)
	})

	afterEach(async () => {
		logSpy.mockRestore()
		if (previousXdgConfigHome === undefined) delete process.env.XDG_CONFIG_HOME
		else process.env.XDG_CONFIG_HOME = previousXdgConfigHome
		await rm(dir, { recursive: true, force: true })
	})

	it('prints the address and the Ed25519 public key derived from the stored seed', async () => {
		const keys = deriveMailboxKeys(Buffer.from(SEED_BASE64, 'base64'))
		const expectedAddress = computeMailboxAddress(encodeKeyMaterial(keys.x25519.publicKeyRaw))
		const expectedEd25519 = encodeKeyMaterial(keys.ed25519.publicKeyRaw)

		await runIdentityCommand([])

		const printed = logSpy.mock.calls.map((call: Array<unknown>) => String(call[0])).join('\n')
		expect(printed).toContain(expectedAddress)
		expect(printed).toContain(expectedEd25519)
	})

	/**
	 * The assertion that matters most here is the negative one: `seed.json`
	 * holds the seed in clear (crypto/seed-store.ts), every private key of
	 * this mailbox derives from it, and this command exists precisely to be
	 * copied and pasted somewhere else.
	 */
	it('never prints the seed, the X25519 public key, or any private key material', () => {
		const seed = Buffer.from(SEED_BASE64, 'base64')
		const keys = deriveMailboxKeys(seed)
		const output = formatIdentityOutput({
			keys,
			publicKeyX25519Base64: encodeKeyMaterial(keys.x25519.publicKeyRaw),
			publicKeyEd25519Base64: encodeKeyMaterial(keys.ed25519.publicKeyRaw),
			address: computeMailboxAddress(encodeKeyMaterial(keys.x25519.publicKeyRaw)),
		})

		expect(output).not.toContain(SEED_BASE64)
		expect(output).not.toContain(seed.toString('hex'))
		expect(output).not.toContain(encodeKeyMaterial(keys.x25519.publicKeyRaw))
		expect(output).not.toContain('PRIVATE KEY')
		for (const pair of [keys.x25519, keys.ed25519]) {
			const pkcs8 = pair.privateKey.export({ format: 'der', type: 'pkcs8' }) as Buffer
			expect(output).not.toContain(pkcs8.toString('base64'))
		}
	})

	it('refuses an argument rather than ignoring it', async () => {
		const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
		const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
			throw new Error('process.exit')
		})

		await expect(runIdentityCommand(['--seed'])).rejects.toThrow()
		expect(exitSpy).toHaveBeenCalledWith(1)

		exitSpy.mockRestore()
		errorSpy.mockRestore()
	})
})
