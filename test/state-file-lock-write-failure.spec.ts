import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { acquireFileLock, lockPathFor, releaseFileLock } from '../src/config/state-file-lock.js'

/**
 * Issue #2036: the lock file is created exclusively before the token is written into it. A write
 * that failed in between left an empty file, with no owner, which the other instances took for a
 * live holder until the staleness threshold, 15 s later.
 */
const failures = vi.hoisted(() => ({
	writes: 0,
	partialWrites: 0,
	slowWriteMs: 0,
	onSlowWriteStart: null as (() => void) | null,
	closes: 0,
	statFailures: 0,
	replaceLockOnStatFailure: false,
	afterNextStat: null as (() => Promise<void>) | null,
	capturedReadFailures: 0,
	afterNextLockRead: null as (() => Promise<void>) | null,
}))

vi.mock('node:fs/promises', async (importOriginal) => {
	const actual = await importOriginal<typeof import('node:fs/promises')>()
	return {
		...actual,
		readFile: (async (...args: Parameters<typeof actual.readFile>) => {
			const [path] = args
			if (failures.capturedReadFailures > 0 && String(path).endsWith('.removing')) {
				failures.capturedReadFailures -= 1
				throw Object.assign(new Error('permission denied'), { code: 'EACCES' })
			}
			const result = await actual.readFile(...args)
			const hook = failures.afterNextLockRead
			failures.afterNextLockRead = null
			// Another caller acts right after this call read the lock, before it acts on what it read.
			await hook?.()
			return result
		}) as typeof actual.readFile,
		stat: (async (...args: Parameters<typeof actual.stat>) => {
			const result = await actual.stat(...args)
			const hook = failures.afterNextStat
			failures.afterNextStat = null
			// Another caller acts right after this call looked at the file, before it acts on what it saw.
			await hook?.()
			return result
		}) as typeof actual.stat,
		open: (async (...args: Parameters<typeof actual.open>) => {
			const handle = await actual.open(...args)
			if (failures.statFailures > 0) {
				failures.statFailures -= 1
				// The file exists, empty, and its identity cannot be read.
				handle.stat = (async () => {
					if (failures.replaceLockOnStatFailure) {
						await actual.rm(args[0], { force: true })
						await actual.writeFile(args[0], 'other-caller-token')
					}
					throw Object.assign(new Error('stat failed'), { code: 'EIO' })
				}) as typeof handle.stat
			}
			if (failures.writes > 0) {
				failures.writes -= 1
				handle.writeFile = (() =>
					Promise.reject(
						Object.assign(new Error('disk full'), { code: 'ENOSPC' }),
					)) as typeof handle.writeFile
			}
			if (failures.partialWrites > 0) {
				failures.partialWrites -= 1
				const writeFile = handle.writeFile.bind(handle)
				// The disk fills up half way: half of the token is on the file, then the write rejects.
				handle.writeFile = (async (data: string) => {
					await writeFile(data.slice(0, Math.floor(data.length / 2)))
					throw Object.assign(new Error('disk full'), { code: 'ENOSPC' })
				}) as typeof handle.writeFile
			}
			if (failures.slowWriteMs > 0) {
				const delay = failures.slowWriteMs
				failures.slowWriteMs = 0
				const onStart = failures.onSlowWriteStart
				failures.onSlowWriteStart = null
				// The write hangs longer than the staleness threshold, then rejects without writing anything.
				handle.writeFile = (async () => {
					onStart?.()
					await new Promise((resolve) => setTimeout(resolve, delay))
					throw Object.assign(new Error('disk gone'), { code: 'EIO' })
				}) as typeof handle.writeFile
			}
			if (failures.closes > 0) {
				failures.closes -= 1
				const close = handle.close.bind(handle)
				// The descriptor is released, yet the call reports the failure (network file system).
				handle.close = (async () => {
					await close()
					throw Object.assign(new Error('close failed'), { code: 'EIO' })
				}) as typeof handle.close
			}
			return handle
		}) as typeof actual.open,
	}
})

describe('acquireFileLock when the token cannot be written', () => {
	let directory: string

	beforeEach(async () => {
		directory = await mkdtemp(join(tmpdir(), 'state-lock-write-failure-'))
		failures.writes = 0
		failures.partialWrites = 0
		failures.slowWriteMs = 0
		failures.onSlowWriteStart = null
		failures.closes = 0
		failures.statFailures = 0
		failures.replaceLockOnStatFailure = false
		failures.afterNextStat = null
		failures.capturedReadFailures = 0
		failures.afterNextLockRead = null
	})

	afterEach(async () => {
		await rm(directory, { recursive: true, force: true })
	})

	it('leaves no lock file behind and rethrows the write error', async () => {
		const lockPath = lockPathFor(join(directory, 'state.json'))
		failures.writes = 1

		await expect(acquireFileLock(lockPath)).rejects.toMatchObject({ code: 'ENOSPC' })

		expect(await readdir(directory)).toEqual([])
	})

	it('leaves no lock file behind when half of the token was written', async () => {
		const lockPath = lockPathFor(join(directory, 'state.json'))
		failures.partialWrites = 1

		await expect(acquireFileLock(lockPath)).rejects.toMatchObject({ code: 'ENOSPC' })

		expect(await readdir(directory)).toEqual([])
	})

	it('creates the lock file readable by its owner only', async () => {
		const lockPath = lockPathFor(join(directory, 'state.json'))

		const token = await acquireFileLock(lockPath)

		expect((await stat(lockPath)).mode & 0o777).toBe(0o600)
		await releaseFileLock(lockPath, token)
	})

	it('lets the next caller take the lock at once', async () => {
		const lockPath = lockPathFor(join(directory, 'state.json'))
		failures.writes = 1
		await expect(acquireFileLock(lockPath)).rejects.toMatchObject({ code: 'ENOSPC' })

		const token = await acquireFileLock(lockPath, { acquireTimeoutMs: 1_000 })

		await releaseFileLock(lockPath, token)
		expect(await readdir(directory)).toEqual([])
	})

	it('leaves no lock file behind when closing the file fails after the token was written', async () => {
		const lockPath = lockPathFor(join(directory, 'state.json'))
		failures.closes = 1

		await expect(acquireFileLock(lockPath)).rejects.toMatchObject({ code: 'EIO' })

		expect(await readdir(directory)).toEqual([])
	})

	it('keeps the lock another caller creates between the look at the failed lock and its removal', async () => {
		const lockPath = lockPathFor(join(directory, 'state.json'))
		failures.writes = 1
		// The first look at a file after the write failed is followed by another caller's lock
		// replacing the one this call created.
		failures.afterNextStat = async () => {
			await rm(lockPath, { force: true })
			await writeFile(lockPath, 'other-caller-token')
		}

		await expect(acquireFileLock(lockPath)).rejects.toMatchObject({ code: 'ENOSPC' })

		expect(await readFile(lockPath, 'utf8').catch(() => null)).toBe('other-caller-token')
		expect(await readdir(directory)).toEqual(['state.json.lock'])
	})

	it('removes the empty lock file it created when its identity cannot be read', async () => {
		const lockPath = lockPathFor(join(directory, 'state.json'))
		failures.statFailures = 1

		await expect(acquireFileLock(lockPath)).rejects.toMatchObject({ code: 'EIO' })

		expect(await readdir(directory)).toEqual([])
	})

	it('keeps a lock that holds a token when its own identity cannot be read', async () => {
		const lockPath = lockPathFor(join(directory, 'state.json'))
		failures.statFailures = 1
		failures.replaceLockOnStatFailure = true

		await expect(acquireFileLock(lockPath)).rejects.toMatchObject({ code: 'EIO' })

		expect(await readFile(lockPath, 'utf8').catch(() => null)).toBe('other-caller-token')
		expect(await readdir(directory)).toEqual(['state.json.lock'])
	})

	it('keeps the lock another caller took over while its own write hung, then failed', async () => {
		const lockPath = lockPathFor(join(directory, 'state.json'))
		failures.slowWriteMs = 400
		// The call that opens the file first is the one whose write hangs: the second call starts only
		// once the first is stuck in its write, so the two never race for the file.
		const writeStarted = new Promise<void>((resolve) => {
			failures.onSlowWriteStart = resolve
		})
		const hung = acquireFileLock(lockPath, { staleLockMs: 100 })
		const hungOutcome = hung.then(
			() => 'acquired',
			(error: NodeJS.ErrnoException) => error.code,
		)
		await writeStarted

		// The empty file is judged stale after 100 ms and replaced by this caller's own lock.
		const token = await acquireFileLock(lockPath, { staleLockMs: 100, acquireTimeoutMs: 2_000 })
		expect(await hungOutcome).toBe('EIO')

		expect(await readFile(lockPath, 'utf8').catch(() => null)).toBe(token)
		await releaseFileLock(lockPath, token)
	})

	it('puts back the lock of another caller when reading the file captured to release fails', async () => {
		const lockPath = lockPathFor(join(directory, 'state.json'))
		const token = await acquireFileLock(lockPath)
		failures.capturedReadFailures = 1
		// The lock is taken over by another caller right after the release read it as its own.
		failures.afterNextLockRead = async () => {
			await rm(lockPath, { force: true })
			await writeFile(lockPath, 'other-caller-token')
		}

		await releaseFileLock(lockPath, token)

		expect(await readFile(lockPath, 'utf8').catch(() => null)).toBe('other-caller-token')
		expect(await readdir(directory)).toEqual(['state.json.lock'])
	})

	it('puts back the lock of another caller when reading the file captured to check it is empty fails', async () => {
		const lockPath = lockPathFor(join(directory, 'state.json'))
		failures.statFailures = 1
		failures.replaceLockOnStatFailure = true
		failures.capturedReadFailures = 1

		await expect(acquireFileLock(lockPath)).rejects.toBeInstanceOf(Error)

		expect(await readFile(lockPath, 'utf8').catch(() => null)).toBe('other-caller-token')
		expect(await readdir(directory)).toEqual(['state.json.lock'])
	})
})
