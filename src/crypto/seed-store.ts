/**
 * Local persistence for this device's mailbox seed: the seed is the only
 * thing this connector writes to disk for its own identity. This is an
 * accepted risk, the same one that applies to the OAuth token pair
 * (config/local-store.ts): the local file always carries the seed in
 * clear, with no passphrase. No encryption of this file is invented here
 * for the same reason oauth/token-store.ts does not invent one for the
 * refresh token: that risk is accepted explicitly, not something a later
 * change should close unilaterally.
 *
 * `AES_KEY_BYTES`-independent: this stores the 32-byte seed itself
 * (`SEED_BYTES`, crypto/envelope-crypto.ts), never a derived key, so a
 * future HKDF label revision (a `v2` domain-separation string) still
 * derives correctly from the same stored seed without a migration here.
 */
import { join } from 'node:path'
import { z } from 'zod'
import { readJsonState, writeJsonState } from '../config/local-store.js'
import { resolveConfigDir } from '../config/paths.js'
import { SEED_BYTES, generateMailboxSeed } from './envelope-crypto.js'

const seedRecordSchema = z.object({
	seed: z.string().min(1),
	createdAt: z.string().datetime(),
})

function seedStorePath(): string {
	return join(resolveConfigDir(), 'seed.json')
}

/**
 * Reads the stored seed, generating and persisting a fresh one on first
 * use. There is no separate "init" command for this: the identity-linking
 * flow needs a key pair to exist before it can present one, and the seed
 * never needs to exist before that first need, so lazily creating it here
 * -- exactly once, the file's presence itself is the guard -- is simpler
 * than adding a whole extra CLI verb for something no other flow requires.
 *
 * Not idempotent-safe against a concurrent first run from two processes
 * (a narrow race: both read "absent", both generate, the second write
 * wins): acceptable here because `pliscelle-mcp` is a single long-lived
 * subprocess per device in normal operation, and a human running
 * `pair`/`login`/`ratify` concurrently with a first `serve` on a
 * brand-new install is not a supported sequence this package otherwise
 * guards against either (see, e.g., client-record.ts's own single-writer
 * assumption).
 */
export async function ensureMailboxSeed(): Promise<Buffer> {
	const existing = await readJsonState(seedStorePath(), seedRecordSchema)
	if (existing) {
		const seed = Buffer.from(existing.seed, 'base64')
		if (seed.length !== SEED_BYTES) {
			throw new Error(
				`Stored AIScelle seed at ${seedStorePath()} is ${seed.length} bytes, expected ${SEED_BYTES}. The file is corrupt; delete it to generate a new mailbox identity (this destroys access to this device's current mailbox key material).`,
			)
		}
		return seed
	}

	const seed = generateMailboxSeed()
	await writeJsonState(seedStorePath(), {
		seed: seed.toString('base64'),
		createdAt: new Date().toISOString(),
	} satisfies z.infer<typeof seedRecordSchema>)
	return seed
}
