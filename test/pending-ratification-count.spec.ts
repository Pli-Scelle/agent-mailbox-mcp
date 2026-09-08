import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * A correspondent authorized in the management tab cannot write until a
 * device has ratified them, and nothing else in the product tells their
 * owner (issue #959). The count rides along on every tool response, next to
 * the message count, because the agent is the one surface the owner is
 * already looking at.
 *
 * The message count is stubbed here: it costs a round trip and this file is
 * about the local half. What matters is that the ratification count is read
 * from the allowlist on disk and never from the server, which is what
 * ratification exists to guarantee (spec section 5.3).
 */
vi.mock('../src/api/mailbox-client.js', () => ({
	fetchPendingCount: () => Promise.resolve(0),
}))

const { appendPendingCount } = await import('../src/tools/pending-count.js')

/**
 * Field names come from `localSenderRecordSchema` in
 * `src/trust/allowlist-store.ts`. They matter: `readJsonState` drops a file
 * that fails the schema and answers as if the allowlist were empty, so a
 * fixture with the wrong shape would make a broken count look correct.
 */
function entry(id: string, ratifiedLocally: boolean) {
	return {
		serverSenderId: id,
		address: `aisc_${id}`,
		publicKeyEd25519: 'AAAA',
		trustLevel: 'data' as const,
		label: id,
		isActiveOnServer: true,
		ratifiedLocally,
		ratifiedLocallyAt: ratifiedLocally ? '2026-08-31T00:00:00.000Z' : null,
	}
}

describe('pending ratification count', () => {
	let dir: string
	let previousXdgConfigHome: string | undefined

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), 'aiscelle-mcp-ratify-count-'))
		previousXdgConfigHome = process.env.XDG_CONFIG_HOME
		process.env.XDG_CONFIG_HOME = dir
		await mkdir(join(dir, 'pliscelle-mcp'), { recursive: true })
	})

	afterEach(async () => {
		if (previousXdgConfigHome === undefined) delete process.env.XDG_CONFIG_HOME
		else process.env.XDG_CONFIG_HOME = previousXdgConfigHome
		await rm(dir, { recursive: true, force: true })
	})

	async function writeAllowlist(entries: Array<ReturnType<typeof entry>>) {
		await writeFile(join(dir, 'pliscelle-mcp', 'allowlist.json'), JSON.stringify({ entries }))
	}

	it('counts only the correspondents this device has not ratified', async () => {
		await writeAllowlist([entry('a', false), entry('b', true), entry('c', false)])

		const result = await appendPendingCount({ ok: true })

		expect(result.pendingRatificationCount).toBe(2)
	})

	it('reports zero when every known correspondent is ratified', async () => {
		await writeAllowlist([entry('a', true), entry('b', true)])

		const result = await appendPendingCount({ ok: true })

		expect(result.pendingRatificationCount).toBe(0)
	})

	it('reports zero on a device that knows no correspondent at all', async () => {
		await writeAllowlist([])

		const result = await appendPendingCount({ ok: true })

		expect(result.pendingRatificationCount).toBe(0)
	})

	it('leaves the payload it wraps untouched', async () => {
		await writeAllowlist([entry('a', false)])

		const result = await appendPendingCount({ messageId: 'msg-1', ok: true })

		expect(result.messageId).toBe('msg-1')
		expect(result.ok).toBe(true)
	})
})
