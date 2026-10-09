import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentMailboxApiError } from '../src/api/mailbox-client.js'

interface LinkRequest {
	publicKeyX25519: string
	publicKeyEd25519: string
}

const linkMailboxIdentity = vi.fn<(request: LinkRequest) => Promise<unknown>>()

vi.mock('../src/api/mailbox-client.js', async (importOriginal) => ({
	...(await importOriginal<typeof import('../src/api/mailbox-client.js')>()),
	linkMailboxIdentity: (...args: [LinkRequest]) => linkMailboxIdentity(...args),
}))

async function readSeed(configDir: string): Promise<string> {
	const record = JSON.parse(await readFile(join(configDir, 'pliscelle-mcp', 'seed.json'), 'utf8')) as { seed: string }
	return record.seed
}

describe('ensureMailboxLinked with a rotated key', () => {
	let configDir: string
	const previousXdg = process.env.XDG_CONFIG_HOME

	beforeEach(async () => {
		configDir = await mkdtemp(join(tmpdir(), 'pliscelle-mcp-link-'))
		process.env.XDG_CONFIG_HOME = configDir
		vi.resetModules()
		linkMailboxIdentity.mockReset()
	})

	afterEach(() => {
		if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME
		else process.env.XDG_CONFIG_HOME = previousXdg
	})

	it('replaces the seed and retries the link once, with no manual action', async () => {
		const { ensureMailboxLinked } = await import('../src/crypto/ensure-mailbox-linked.js')
		const { ensureMailboxSeed } = await import('../src/crypto/seed-store.js')
		await ensureMailboxSeed()
		const seedBefore = await readSeed(configDir)

		linkMailboxIdentity
			.mockRejectedValueOnce(new AgentMailboxApiError(400, 'rotated', 'identity_key_rotated'))
			.mockResolvedValueOnce({ address: 'new-address' })

		await expect(ensureMailboxLinked()).resolves.toBe('new-address')

		expect(linkMailboxIdentity).toHaveBeenCalledTimes(2)
		expect(await readSeed(configDir)).not.toBe(seedBefore)
		const first = linkMailboxIdentity.mock.calls[0]?.[0]
		const second = linkMailboxIdentity.mock.calls[1]?.[0]
		expect(second?.publicKeyX25519).not.toBe(first?.publicKeyX25519)
	})

	it('does not retry on another refusal', async () => {
		const { ensureMailboxLinked } = await import('../src/crypto/ensure-mailbox-linked.js')
		linkMailboxIdentity.mockRejectedValue(new AgentMailboxApiError(400, 'other'))

		await expect(ensureMailboxLinked()).rejects.toBeInstanceOf(AgentMailboxApiError)
		expect(linkMailboxIdentity).toHaveBeenCalledTimes(1)
	})

	it('gives up after a single retry when the new key is refused too', async () => {
		const { ensureMailboxLinked } = await import('../src/crypto/ensure-mailbox-linked.js')
		linkMailboxIdentity.mockRejectedValue(new AgentMailboxApiError(400, 'rotated', 'identity_key_rotated'))

		await expect(ensureMailboxLinked()).rejects.toBeInstanceOf(AgentMailboxApiError)
		expect(linkMailboxIdentity).toHaveBeenCalledTimes(2)
	})
})
