import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runPairCommand } from '../src/cli/pair.js'
import type { RegisterDeviceResult } from '../src/oauth/pairing-registration.js'

const registerDevice = vi.fn<() => Promise<RegisterDeviceResult>>()
const runLoginCommand = vi.fn<() => Promise<void>>()

vi.mock('../src/oauth/pairing-registration.js', () => ({
	registerDevice: (...args: Array<unknown>) => registerDevice(...(args as [])),
}))
// Hoisted alongside the `vi.mock` factory that returns it: a plain class
// declaration would still be in its temporal dead zone when the factory
// runs, and the mocked module would export nothing under this name.
const { MailboxLinkError } = vi.hoisted(() => ({
	MailboxLinkError: class MailboxLinkError extends Error {
		override readonly name = 'MailboxLinkError'
	},
}))
vi.mock('../src/cli/login.js', () => ({
	MailboxLinkError,
	runLoginCommand: (...args: Array<unknown>) => runLoginCommand(...(args as [])),
}))

const FAKE_RECORD: RegisterDeviceResult = {
	// The real `Configuration` type is opaque to this module: pair.ts only
	// reads `record` off the result, so a stub object is enough here.
	configuration: {} as RegisterDeviceResult['configuration'],
	record: {
		clientId: 'client-123',
		redirectUri: 'http://127.0.0.1:12345/callback',
		registeredAt: new Date().toISOString(),
	},
}

/**
 * Guarantees demanded by the product owner on 2026-08-30: `pair` must sign
 * the device in by itself, `--no-login` must be able to opt out, and a
 * failure of that chained step must tell the user exactly what is saved
 * (the registration, and the spent code) and what is not (the pairing
 * itself, which `login` alone can finish -- see cli/login.ts).
 */
describe('runPairCommand', () => {
	let logSpy: ReturnType<typeof vi.spyOn>
	let errorSpy: ReturnType<typeof vi.spyOn>

	beforeEach(() => {
		registerDevice.mockReset().mockResolvedValue(FAKE_RECORD)
		runLoginCommand.mockReset().mockResolvedValue(undefined)
		logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined)
		errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
	})

	afterEach(() => {
		logSpy.mockRestore()
		errorSpy.mockRestore()
		process.exitCode = undefined
	})

	it('chains login automatically by default once pairing succeeds', async () => {
		await runPairCommand(['--code', 'PAIRING_CODE'])

		expect(registerDevice).toHaveBeenCalledWith({ pairingCode: 'PAIRING_CODE', deviceName: expect.any(String) })
		expect(runLoginCommand).toHaveBeenCalledTimes(1)
		expect(runLoginCommand).toHaveBeenCalledWith([])
	})

	it('does not chain login when --no-login is given', async () => {
		await runPairCommand(['--code', 'PAIRING_CODE', '--no-login'])

		expect(registerDevice).toHaveBeenCalledTimes(1)
		expect(runLoginCommand).not.toHaveBeenCalled()
		const printed = logSpy.mock.calls.map((call: Array<unknown>) => String(call[0])).join('\n')
		expect(printed).toContain('npx @pliscelle/agent-mailbox-mcp login')
		expect(printed).toContain('finish the pairing')
	})

	it('keeps the device registered and says so plainly when the chained login fails', async () => {
		runLoginCommand.mockRejectedValue(new Error('the browser step timed out'))

		await expect(runPairCommand(['--code', 'PAIRING_CODE'])).resolves.toBeUndefined()

		expect(registerDevice).toHaveBeenCalledTimes(1)
		const printedErrors = errorSpy.mock.calls.map((call: Array<unknown>) => String(call[0])).join('\n')
		expect(printedErrors).toContain("This device's registration is saved")
		expect(printedErrors).toContain('the pairing is not finished yet')
		expect(printedErrors).toContain('client-123')
		expect(printedErrors).toContain('the browser step timed out')
		expect(printedErrors).toContain('npx @pliscelle/agent-mailbox-mcp login')
		expect(printedErrors).toContain('There is no need to pair again')
		expect(process.exitCode).toBe(1)
	})

	/**
	 * A link failure already carries its own instruction, and that
	 * instruction includes the one case where pairing again IS the answer,
	 * an expired pairing. Printing "there is no need to pair again" under
	 * it would contradict it in the same terminal.
	 */
	it('adds no advice of its own when the failure is the mailbox link', async () => {
		runLoginCommand.mockRejectedValue(new MailboxLinkError('Signed in, but ... run pair once more.'))

		await runPairCommand(['--code', 'PAIRING_CODE'])

		const printedErrors = errorSpy.mock.calls.map((call: Array<unknown>) => String(call[0])).join('\n')
		expect(printedErrors).toContain('run pair once more')
		expect(printedErrors).not.toContain('There is no need to pair again')
	})
})
