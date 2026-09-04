import { mkdir, mkdtemp, open, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { acquireLock, releaseLock, withRefreshLock } from '../src/oauth/refresh-lock.js'

describe('withRefreshLock', () => {
	let dir: string
	let previousXdgConfigHome: string | undefined

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), 'aiscelle-mcp-refresh-lock-test-'))
		previousXdgConfigHome = process.env.XDG_CONFIG_HOME
		process.env.XDG_CONFIG_HOME = dir
	})

	afterEach(async () => {
		if (previousXdgConfigHome === undefined) delete process.env.XDG_CONFIG_HOME
		else process.env.XDG_CONFIG_HOME = previousXdgConfigHome
		await rm(dir, { recursive: true, force: true })
	})

	function lockPath(): string {
		return join(dir, 'pliscelle-mcp', 'tokens.json.lock')
	}

	it('runs the callback and leaves no lock file behind once it resolves', async () => {
		const result = await withRefreshLock(() => Promise.resolve('done'))

		expect(result).toBe('done')
		await expect(stat(lockPath())).rejects.toThrow()
	})

	it('releases the lock even when the callback throws', async () => {
		await expect(withRefreshLock(() => Promise.reject(new Error('boom')))).rejects.toThrow('boom')

		await expect(stat(lockPath())).rejects.toThrow()
	})

	it('serializes two concurrent callers: the second only starts once the first has released the lock', async () => {
		const events: Array<string> = []

		const first = withRefreshLock(async () => {
			events.push('first-start')
			await new Promise((resolve) => setTimeout(resolve, 30))
			events.push('first-end')
		})
		// Give the first caller time to actually acquire the lock before the
		// second one starts racing it.
		await new Promise((resolve) => setTimeout(resolve, 5))

		const second = withRefreshLock(() => {
			events.push('second-start')
			return Promise.resolve()
		})

		await Promise.all([first, second])

		expect(events).toEqual(['first-start', 'first-end', 'second-start'])
	})

	it('reclaims a lock file older than the staleness threshold instead of waiting for it forever', async () => {
		await mkdir(join(dir, 'pliscelle-mcp'), { recursive: true })
		const handle = await open(lockPath(), 'wx')
		await handle.close()
		// Back-date the lock well past the staleness threshold, simulating a
		// sibling process that crashed mid-refresh and never released it.
		const staleTime = new Date(Date.now() - 60_000)
		await utimes(lockPath(), staleTime, staleTime)

		let ran = false
		await withRefreshLock(() => {
			ran = true
			return Promise.resolve()
		})

		expect(ran).toBe(true)
	})

	it('does not let a live but slow holder be dispossessed by a stale-lock reclaim', async () => {
		const events: Array<string> = []
		// A callback duration longer than `staleLockMs`, with a renewal interval
		// short enough that the lock's mtime never goes stale in between: this
		// proves the ownership token plus the renewal loop, not merely luck,
		// are what keep the second caller from stealing the lock mid-refresh.
		const shortOptions = {
			staleLockMs: 120,
			renewalIntervalMs: 20,
			acquireTimeoutMs: 3_000,
			acquireRetryDelayMs: 10,
		}

		const first = withRefreshLock(async () => {
			events.push('first-start')
			await new Promise((resolve) => setTimeout(resolve, 400))
			events.push('first-end')
		}, shortOptions)
		await new Promise((resolve) => setTimeout(resolve, 20))

		const second = withRefreshLock(() => {
			events.push('second-start')
			return Promise.resolve()
		}, shortOptions)

		await Promise.all([first, second])

		expect(events).toEqual(['first-start', 'first-end', 'second-start'])
	})

	it('never releases a lock that carries a different ownership token', async () => {
		const token = await acquireLock()
		// Simulates the file having been rewritten by some other process
		// (a reclaim this call lost a race against, however unlikely with the
		// renewal loop running): `releaseLock` must refuse to touch content it
		// does not own, rather than blindly deleting whatever sits there.
		await writeFile(lockPath(), 'someone-elses-token')

		await releaseLock(token)

		expect(await readFile(lockPath(), 'utf8')).toBe('someone-elses-token')
	})
})
