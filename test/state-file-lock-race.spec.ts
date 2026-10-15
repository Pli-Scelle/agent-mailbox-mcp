import { mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { StateFileLockTimeoutError, acquireFileLock, releaseFileLock } from '../src/config/state-file-lock.js'

/**
 * The removal of a lock file used to be decided on one read (its age, its token) and done by a
 * later `rm` of the path: whatever lock sat there by then went, even one another caller had just
 * taken. The gate below holds the first removal aimed at the lock path, a `rm` or a `rename`, so
 * the test can put another caller's lock in place during that window, as a real interleaving
 * would.
 */
const gate = vi.hoisted(() => ({
	path: null as string | null,
	held: null as { reached: () => void; release: Promise<void> } | null,
}))

vi.mock('node:fs/promises', async (importOriginal) => {
	const actual = await importOriginal<typeof import('node:fs/promises')>()
	const holdFirstRemoval = async (target: unknown) => {
		if (gate.held && gate.path !== null && String(target) === gate.path) {
			const { reached, release } = gate.held
			gate.held = null
			reached()
			await release
		}
	}
	return {
		...actual,
		rm: (async (target: Parameters<typeof actual.rm>[0], ...rest: Array<unknown>) => {
			await holdFirstRemoval(target)
			return (actual.rm as (...args: Array<unknown>) => Promise<void>)(target, ...rest)
		}) as typeof actual.rm,
		rename: (async (from: Parameters<typeof actual.rename>[0], to: Parameters<typeof actual.rename>[1]) => {
			await holdFirstRemoval(from)
			return actual.rename(from, to)
		}) as typeof actual.rename,
	}
})

function armGate(lockPath: string): { reached: Promise<void>; open: () => void } {
	let reached!: () => void
	let open!: () => void
	const reachedPromise = new Promise<void>((resolve) => (reached = resolve))
	const release = new Promise<void>((resolve) => (open = resolve))
	gate.path = lockPath
	gate.held = { reached, release }
	return { reached: reachedPromise, open }
}

describe('state file lock, removal racing another caller', () => {
	let dir: string
	let lockPath: string

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), 'pliscelle-mcp-lock-race-'))
		lockPath = join(dir, 'state.json.lock')
	})

	afterEach(async () => {
		gate.path = null
		gate.held = null
		await rm(dir, { recursive: true, force: true })
	})

	it('a stale lock reclaimed by two waiters never lets both hold it', async () => {
		await writeFile(lockPath, 'dead-holder')
		const longAgo = new Date(Date.now() - 60_000)
		await utimes(lockPath, longAgo, longAgo)
		const options = { staleLockMs: 1_000, acquireRetryDelayMs: 5, acquireTimeoutMs: 400 }

		// The second waiter judges the dead lock stale, then stalls on its removal.
		const stalled = armGate(lockPath)
		const second = acquireFileLock(lockPath, options).then(
			(token) => ({ token }),
			(error: Error) => ({ error }),
		)
		await stalled.reached

		// Meanwhile the first waiter reclaims the dead lock and takes it.
		const firstToken = await acquireFileLock(lockPath, options)
		stalled.open()
		const outcome = await second

		expect(await readFile(lockPath, 'utf8')).toBe(firstToken)
		expect(outcome).toHaveProperty('error')
		expect((outcome as { error: Error }).error).toBeInstanceOf(StateFileLockTimeoutError)
	})

	it('a release never removes the lock another caller took in the meantime', async () => {
		const options = { staleLockMs: 1_000, acquireRetryDelayMs: 5, acquireTimeoutMs: 400 }
		const ownToken = await acquireFileLock(lockPath, options)

		// The release has read its own token and stalls before the removal; in that window the
		// lock was reclaimed by another caller (a holder stalled past the staleness threshold).
		const stalled = armGate(lockPath)
		const release = releaseFileLock(lockPath, ownToken)
		await stalled.reached
		await writeFile(lockPath, 'other-caller-token')
		stalled.open()
		await release

		const left = await readFile(lockPath, 'utf8').catch(() => '(lock file removed)')
		expect(left).toBe('other-caller-token')
	})

	it('a release that finds the lock of another caller never moves it off its path', async () => {
		// The holder stalled past the staleness threshold and another caller took the lock over.
		await writeFile(lockPath, 'other-caller-token')

		// Moving that lock aside, even to put it back, leaves the path free for a third caller:
		// two of them would then hold it. The release must leave the path alone.
		const stalled = armGate(lockPath)
		let moved = false
		void stalled.reached.then(() => {
			moved = true
			stalled.open()
		})
		await releaseFileLock(lockPath, 'own-token-of-the-stalled-holder')

		expect(moved).toBe(false)
		expect(await readFile(lockPath, 'utf8')).toBe('other-caller-token')
	})

	it('a release still removes its own lock', async () => {
		const ownToken = await acquireFileLock(lockPath)

		await releaseFileLock(lockPath, ownToken)

		await expect(readFile(lockPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
	})
})
