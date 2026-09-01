import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
	DuplicateAllowlistKeyError,
	type LocalSenderRecord,
	markRatifiedLocally,
	readAllowlist,
	reconcileAllowlistEntries,
	reconcileAllowlistWithServer,
} from '../src/trust/allowlist-store.js'

function localEntry(overrides: Partial<LocalSenderRecord> = {}): LocalSenderRecord {
	return {
		serverSenderId: 'sender-1',
		address: 'aisc_sender1',
		publicKeyEd25519: 'a2V5MQ==',
		trustLevel: 'data',
		label: 'Alice',
		isActiveOnServer: true,
		ratifiedLocally: false,
		ratifiedLocallyAt: null,
		...overrides,
	}
}

function serverEntry(overrides: Partial<Parameters<typeof reconcileAllowlistEntries>[1][number]> = {}) {
	return {
		id: 'sender-1',
		senderAddress: 'aisc_sender1',
		senderPublicKeyEd25519: 'a2V5MQ==',
		trustLevel: 'data' as const,
		label: 'Alice',
		isActive: true,
		...overrides,
	}
}

describe('reconcileAllowlistEntries, keeping local ratification authoritative', () => {
	it('drops a local entry whose server counterpart is now inactive', () => {
		const local = [localEntry({ ratifiedLocally: true, ratifiedLocallyAt: '2026-01-01T00:00:00.000Z' })]
		const server = [serverEntry({ isActive: false })]
		expect(reconcileAllowlistEntries(local, server)).toEqual([])
	})

	it('drops a local entry the server no longer lists at all', () => {
		const local = [localEntry({ ratifiedLocally: true, ratifiedLocallyAt: '2026-01-01T00:00:00.000Z' })]
		expect(reconcileAllowlistEntries(local, [])).toEqual([])
	})

	it('preserves ratifiedLocally state for an entry still active on the server', () => {
		const local = [localEntry({ ratifiedLocally: true, ratifiedLocallyAt: '2026-01-01T00:00:00.000Z' })]
		const server = [serverEntry({ label: 'Alice (renamed)' })]
		const result = reconcileAllowlistEntries(local, server)
		expect(result).toEqual([
			localEntry({
				ratifiedLocally: true,
				ratifiedLocallyAt: '2026-01-01T00:00:00.000Z',
				label: 'Alice (renamed)',
			}),
		])
	})

	it('adds a server entry unknown locally as unratified', () => {
		const result = reconcileAllowlistEntries([], [serverEntry()])
		expect(result).toEqual([localEntry({ ratifiedLocally: false, ratifiedLocallyAt: null })])
	})

	it('resets ratifiedLocally to false when the server reports a DIFFERENT public key under an already-ratified id (a compromised server must not inherit ratification by swapping the key behind a known id)', () => {
		const local = [
			localEntry({
				publicKeyEd25519: 'b2xkS2V5',
				trustLevel: 'data',
				ratifiedLocally: true,
				ratifiedLocallyAt: '2026-01-01T00:00:00.000Z',
			}),
		]
		// Same server sender id, different key, elevated to 'instruction': the
		// exact shape of a compromised-server key-swap attack.
		const server = [serverEntry({ senderPublicKeyEd25519: 'bmV3S2V5', trustLevel: 'instruction' })]

		const result = reconcileAllowlistEntries(local, server)

		expect(result).toEqual([
			localEntry({
				publicKeyEd25519: 'bmV3S2V5',
				trustLevel: 'instruction',
				ratifiedLocally: false,
				ratifiedLocallyAt: null,
			}),
		])
	})

	it('preserves ratifiedLocally when the server reports the SAME public key, even if label and trustLevel changed', () => {
		const local = [
			localEntry({
				publicKeyEd25519: 'a2V5MQ==',
				trustLevel: 'data',
				ratifiedLocally: true,
				ratifiedLocallyAt: '2026-01-01T00:00:00.000Z',
			}),
		]
		const server = [serverEntry({ senderPublicKeyEd25519: 'a2V5MQ==', label: 'Alice (renamed)' })]

		const result = reconcileAllowlistEntries(local, server)

		expect(result).toEqual([
			localEntry({
				publicKeyEd25519: 'a2V5MQ==',
				label: 'Alice (renamed)',
				ratifiedLocally: true,
				ratifiedLocallyAt: '2026-01-01T00:00:00.000Z',
			}),
		])
	})
})

describe('markRatifiedLocally, allowlist file round trip', () => {
	let dir: string
	let previousXdgConfigHome: string | undefined

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), 'aiscelle-mcp-allowlist-test-'))
		previousXdgConfigHome = process.env.XDG_CONFIG_HOME
		process.env.XDG_CONFIG_HOME = dir
	})

	afterEach(async () => {
		if (previousXdgConfigHome === undefined) delete process.env.XDG_CONFIG_HOME
		else process.env.XDG_CONFIG_HOME = previousXdgConfigHome
		await rm(dir, { recursive: true, force: true })
	})

	it('marks a known local entry as ratified', async () => {
		await reconcileAllowlistWithServer([serverEntry()])
		const record = await markRatifiedLocally('sender-1')
		expect(record.ratifiedLocally).toBe(true)
		expect(record.ratifiedLocallyAt).not.toBeNull()

		const stored = await readAllowlist()
		expect(stored.find((entry) => entry.serverSenderId === 'sender-1')?.ratifiedLocally).toBe(true)
	})

	it('throws when the sender id is not known locally', async () => {
		await expect(markRatifiedLocally('unknown')).rejects.toThrow(/No sender with server id/)
	})

	it('refuses ratifying a duplicate-key entry added after the first was already ratified (closes the "innocuous-looking duplicate" elevation attack)', async () => {
		await reconcileAllowlistWithServer([serverEntry({ id: 'sender-1', label: 'Alice' })])
		await markRatifiedLocally('sender-1')

		// A same-key entry under a different label shows up later (e.g. a
		// compromised server trying to slip in an "instruction"-level
		// duplicate of an already-`data`-ratified key).
		await reconcileAllowlistWithServer([
			serverEntry({ id: 'sender-1', label: 'Alice' }),
			serverEntry({ id: 'sender-2', label: 'Alice, definitely legit', trustLevel: 'instruction' }),
		])

		await expect(markRatifiedLocally('sender-2')).rejects.toThrow(DuplicateAllowlistKeyError)
		// The original ratification is left untouched.
		expect((await readAllowlist()).find((entry) => entry.serverSenderId === 'sender-1')?.ratifiedLocally).toBe(true)
	})

	it('refuses ratifying EITHER of two same-key entries that already coexist locally, even before either is ratified', async () => {
		await reconcileAllowlistWithServer([
			serverEntry({ id: 'sender-1', label: 'Alice' }),
			serverEntry({ id: 'sender-2', label: 'Alice, definitely legit' }),
		])

		await expect(markRatifiedLocally('sender-1')).rejects.toThrow(DuplicateAllowlistKeyError)
	})
})
