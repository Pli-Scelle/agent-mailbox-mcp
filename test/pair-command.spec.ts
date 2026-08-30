import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runPairCommand } from '../src/cli/pair.js'
import type { RegisterDeviceResult } from '../src/oauth/pairing-registration.js'

const registerDevice = vi.fn<() => Promise<RegisterDeviceResult>>()
const runLoginCommand = vi.fn<() => Promise<void>>()

vi.mock('../src/oauth/pairing-registration.js', () => ({
	registerDevice: (...args: Array<unknown>) => registerDevice(...(args as [])),
}))
vi.mock('../src/cli/login.js', () => ({
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
 * failure of that chained sign-in must never look like pairing itself
 * failed -- the device registration already happened by the time login
 * runs, and the user must be told that plainly.
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
	})

	it('keeps the device registered and says so plainly when the chained login fails', async () => {
		runLoginCommand.mockRejectedValue(new Error('the browser step timed out'))

		await expect(runPairCommand(['--code', 'PAIRING_CODE'])).resolves.toBeUndefined()

		expect(registerDevice).toHaveBeenCalledTimes(1)
		const printedErrors = errorSpy.mock.calls.map((call: Array<unknown>) => String(call[0])).join('\n')
		expect(printedErrors).toContain('Pairing succeeded and is saved on this device')
		expect(printedErrors).toContain('client-123')
		expect(printedErrors).toContain('the browser step timed out')
		expect(printedErrors).toContain('npx @pliscelle/agent-mailbox-mcp login')
		expect(printedErrors).toContain('There is no need to pair again')
		expect(process.exitCode).toBe(1)
	})
})
