import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { NoClientRegisteredError, requireClientRecord } from '../src/oauth/client-record.js'

/**
 * `login` reads the client record first and prints the message of the error it raises, through the
 * top-level handler of the command line: the person who typed `login` before `pair` reads it, so
 * it is French like the rest of the command line. The other errors of this family (no session,
 * access lost, no refresh token) are raised by `ensureValidSession`, which only the tools, the
 * heartbeat and the hook call: the agent reads those, and they stay English.
 */
describe('requireClientRecord', () => {
	let dir: string
	let previousXdgConfigHome: string | undefined

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), 'aiscelle-mcp-client-record-'))
		previousXdgConfigHome = process.env.XDG_CONFIG_HOME
		process.env.XDG_CONFIG_HOME = dir
	})

	afterEach(async () => {
		if (previousXdgConfigHome === undefined) delete process.env.XDG_CONFIG_HOME
		else process.env.XDG_CONFIG_HOME = previousXdgConfigHome
		await rm(dir, { recursive: true, force: true })
	})

	it('tells the person, in French, to pair this device first', async () => {
		const error = await requireClientRecord().catch((caught: unknown) => caught)

		expect(error).toBeInstanceOf(NoClientRegisteredError)
		expect((error as Error).message).toMatch(/Aucun appairage de cet appareil/)
		expect((error as Error).message).toContain('pair --code <CODE_D_APPAIRAGE>')
	})
})
