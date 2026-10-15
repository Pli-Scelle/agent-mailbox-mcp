import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
	StateFileLockTimeoutError,
	acquireFileLock,
	releaseFileLock,
	withFileLock,
} from '../src/config/state-file-lock.js'

/**
 * A release decides on one read (the token is its own) and then moves the lock aside to remove
 * it. If the lock was taken over in between (a holder stalled past the staleness threshold, then
 * woken), the file moved aside is another caller's live lock: it is put back, and for that
 * instant the path is free. A third caller creating its own lock in that instant used to end
 * with two holders at once, the live one's lock gone for good.
 *
 * Two gates make the interleaving deterministic. The first holds the removal aimed at the lock
 * path, so the takeover can happen after the release read its own token. The second holds the
 * step that puts the captured lock back (`link` or `rename` onto the lock path), so a third
 * caller can try to acquire while the path is free.
 */
const gates = vi.hoisted(() => ({
	path: null as string | null,
	removal: null as { reached: () => void; release: Promise<void> } | null,
	restore: null as { reached: () => void; release: Promise<void> } | null,
}))

async function hold(slot: 'removal' | 'restore'): Promise<void> {
	const gate = gates[slot]
	if (!gate) return
	gates[slot] = null
	gate.reached()
	await gate.release
}

vi.mock('node:fs/promises', async (importOriginal) => {
	const actual = await importOriginal<typeof import('node:fs/promises')>()
	return {
		...actual,
		rename: (async (from: Parameters<typeof actual.rename>[0], to: Parameters<typeof actual.rename>[1]) => {
			if (gates.path !== null && String(from) === gates.path) await hold('removal')
			if (gates.path !== null && String(to) === gates.path) await hold('restore')
			return actual.rename(from, to)
		}) as typeof actual.rename,
		link: (async (existing: Parameters<typeof actual.link>[0], target: Parameters<typeof actual.link>[1]) => {
			if (gates.path !== null && String(target) === gates.path) await hold('restore')
			return actual.link(existing, target)
		}) as typeof actual.link,
	}
})

function arm(slot: 'removal' | 'restore', lockPath: string): { reached: Promise<void>; open: () => void } {
	let reached!: () => void
	let open!: () => void
	const reachedPromise = new Promise<void>((resolve) => (reached = resolve))
	const release = new Promise<void>((resolve) => (open = resolve))
	gates.path = lockPath
	gates[slot] = { reached, release }
	return { reached: reachedPromise, open }
}

describe('state file lock, the path free while a captured lock is put back', () => {
	let dir: string
	let lockPath: string

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), 'pliscelle-mcp-lock-restore-'))
		lockPath = join(dir, 'state.json.lock')
	})

	afterEach(async () => {
		gates.path = null
		gates.removal = null
		gates.restore = null
		await rm(dir, { recursive: true, force: true })
	})

	it('a third caller never ends up holding the lock next to the live holder that was captured', async () => {
		const options = { staleLockMs: 60_000, acquireRetryDelayMs: 5, acquireTimeoutMs: 400 }
		const stalledHolderToken = await acquireFileLock(lockPath, options)

		// The stalled holder wakes up and releases: it has read its own token, and stops before
		// moving the lock aside.
		const removal = arm('removal', lockPath)
		const release = releaseFileLock(lockPath, stalledHolderToken)
		await removal.reached

		// Meanwhile the lock was reclaimed and taken by a live holder.
		await rm(lockPath)
		const liveHolderToken = await acquireFileLock(lockPath, options)

		// The release moves that live lock aside, finds another token, and stops before putting it back.
		const restore = arm('restore', lockPath)
		removal.open()
		await restore.reached

		// The path is free: a third caller acquires now.
		const third = acquireFileLock(lockPath, options).then(
			(token) => ({ token }),
			(error: Error) => ({ error }),
		)
		await new Promise((resolve) => setTimeout(resolve, 100))
		restore.open()
		await release
		const outcome = await third

		// The live holder never released: the lock is still its own, and nobody else got it.
		expect(await readFile(lockPath, 'utf8')).toBe(liveHolderToken)
		expect(outcome).toHaveProperty('error')
		expect((outcome as { error: Error }).error).toBeInstanceOf(StateFileLockTimeoutError)
	})

	// The 240 locked sections run on the file system: a loaded CI runner needs more than vitest's
	// default 5 s, so the test gets a bound above the 20 s acquire timeout its callers are given.
	it('twelve callers racing for the lock lose no update', async () => {
		const counterPath = join(dir, 'counter')
		await writeFile(counterPath, '0')
		const options = { staleLockMs: 60_000, acquireRetryDelayMs: 1, acquireTimeoutMs: 20_000 }

		await Promise.all(
			Array.from({ length: 12 }, async () => {
				for (let i = 0; i < 20; i++) {
					await withFileLock(
						lockPath,
						async () => {
							const value = Number(await readFile(counterPath, 'utf8'))
							await new Promise((resolve) => setImmediate(resolve))
							await writeFile(counterPath, String(value + 1))
						},
						options,
					)
				}
			}),
		)

		expect(await readFile(counterPath, 'utf8')).toBe('240')
	}, 30_000)
})
