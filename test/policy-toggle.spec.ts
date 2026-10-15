import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { isPolicyEnabled, setPolicyEnabled } from '../src/policy/policy-toggle.js'

describe('policy-toggle, the local kill switch', () => {
	let dir: string
	let previousXdgConfigHome: string | undefined

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), 'aiscelle-mcp-policy-toggle-test-'))
		previousXdgConfigHome = process.env.XDG_CONFIG_HOME
		process.env.XDG_CONFIG_HOME = dir
	})

	afterEach(async () => {
		if (previousXdgConfigHome === undefined) delete process.env.XDG_CONFIG_HOME
		else process.env.XDG_CONFIG_HOME = previousXdgConfigHome
		await rm(dir, { recursive: true, force: true })
	})

	it('defaults to enabled on a fresh install with no state file yet', async () => {
		expect(await isPolicyEnabled()).toBe(true)
	})

	it('persists a disable across reads', async () => {
		await setPolicyEnabled(false)
		expect(await isPolicyEnabled()).toBe(false)
	})

	it('persists a re-enable across reads', async () => {
		await setPolicyEnabled(false)
		await setPolicyEnabled(true)
		expect(await isPolicyEnabled()).toBe(true)
	})

	it('fails safe (enabled) rather than fails open when the state file is unreadable JSON', async () => {
		const { writeFile, mkdir } = await import('node:fs/promises')
		const path = join(dir, 'pliscelle-mcp', 'policy.json')
		await mkdir(join(dir, 'pliscelle-mcp'), { recursive: true })
		await writeFile(path, 'not json at all')

		expect(await isPolicyEnabled()).toBe(true)
	})
})
