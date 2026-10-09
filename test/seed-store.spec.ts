import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SEED_BYTES } from '../src/crypto/envelope-crypto.js'
import { ensureMailboxSeed, resetMailboxSeed } from '../src/crypto/seed-store.js'

describe('seed store', () => {
	const previousXdg = process.env.XDG_CONFIG_HOME

	beforeEach(async () => {
		process.env.XDG_CONFIG_HOME = await mkdtemp(join(tmpdir(), 'pliscelle-mcp-seed-'))
	})

	afterEach(() => {
		if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME
		else process.env.XDG_CONFIG_HOME = previousXdg
	})

	it('resetMailboxSeed replaces the stored seed with a fresh one', async () => {
		const before = await ensureMailboxSeed()
		const fresh = await resetMailboxSeed()

		expect(fresh).toHaveLength(SEED_BYTES)
		expect(fresh.equals(before)).toBe(false)
		expect((await ensureMailboxSeed()).equals(fresh)).toBe(true)
	})
})
