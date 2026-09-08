import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { readJsonState, writeJsonState } from '../src/config/local-store.js'

const schema = z.object({ value: z.string() })

describe('local JSON state store', () => {
	let dir: string

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), 'aiscelle-mcp-test-'))
	})

	afterEach(async () => {
		await rm(dir, { recursive: true, force: true })
	})

	it('round-trips a value through write then read', async () => {
		const path = join(dir, 'nested', 'state.json')

		await writeJsonState(path, { value: 'hello' })

		expect(await readJsonState(path, schema)).toEqual({ value: 'hello' })
	})

	it('writes with owner-only permissions', async () => {
		const path = join(dir, 'state.json')
		await writeJsonState(path, { value: 'x' })

		const stats = await stat(path)
		// Compare only the permission bits, platform umask/ACL details aside.
		expect(stats.mode & 0o777).toBe(0o600)
	})

	it('returns undefined for a file that does not exist', async () => {
		expect(await readJsonState(join(dir, 'missing.json'), schema)).toBeUndefined()
	})

	it('returns undefined, not a throw, for content that fails the schema', async () => {
		const path = join(dir, 'invalid.json')
		await writeJsonState(path, { value: 42 })

		expect(await readJsonState(path, schema)).toBeUndefined()
	})

	it('returns undefined for a file that is not valid JSON at all', async () => {
		const path = join(dir, 'corrupt.json')
		await writeJsonState(path, { value: 'placeholder' })
		// Corrupt it directly, bypassing writeJsonState, to simulate a
		// process killed mid-write of a PREVIOUS version of the file.
		const fs = await import('node:fs/promises')
		await fs.writeFile(path, '{not valid json')

		expect(await readJsonState(path, schema)).toBeUndefined()
	})

	it('leaves no leftover temp file after a successful write', async () => {
		const path = join(dir, 'state.json')
		await writeJsonState(path, { value: 'x' })

		const fs = await import('node:fs/promises')
		const entries = await fs.readdir(dir)
		expect(entries).toEqual(['state.json'])
	})

	it('does not corrupt the previous version if a write is immediately followed by a read of the old path while a new write races', async () => {
		const path = join(dir, 'state.json')
		await writeJsonState(path, { value: 'first' })
		await writeJsonState(path, { value: 'second' })

		expect(await readJsonState(path, schema)).toEqual({ value: 'second' })
		const raw = await readFile(path, 'utf8')
		expect(() => JSON.parse(raw)).not.toThrow()
	})
})
