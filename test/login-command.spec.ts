import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MailboxLinkError, runLoginCommand } from '../src/cli/login.js'

const runAuthorizationCodeLogin = vi.fn<() => Promise<void>>()
const runDeviceLogin = vi.fn<() => Promise<void>>()
const loadRegisteredConfiguration = vi.fn<() => Promise<unknown>>()
const ensureMailboxLinked = vi.fn<() => Promise<string>>()

vi.mock('../src/oauth/authorization-code-flow.js', () => ({
	runAuthorizationCodeLogin: (...args: Array<unknown>) => runAuthorizationCodeLogin(...(args as [])),
}))
vi.mock('../src/oauth/device-flow.js', () => ({
	runDeviceLogin: (...args: Array<unknown>) => runDeviceLogin(...(args as [])),
}))
vi.mock('../src/oauth/discovery.js', () => ({
	loadRegisteredConfiguration: (...args: Array<unknown>) => loadRegisteredConfiguration(...(args as [])),
}))
vi.mock('../src/crypto/ensure-mailbox-linked.js', () => ({
	ensureMailboxLinked: (...args: Array<unknown>) => ensureMailboxLinked(...(args as [])),
}))

/**
 * `login` is the last step of setup on every path, so it is where the
 * mailbox link belongs (spec 6.2, and the outage it records). These
 * assert both halves: that the link happens at all, on either flow, and
 * that its failure is never reported as a failure to sign in.
 */
describe('runLoginCommand', () => {
	let logSpy: ReturnType<typeof vi.spyOn>

	beforeEach(() => {
		runAuthorizationCodeLogin.mockReset().mockResolvedValue(undefined)
		runDeviceLogin.mockReset().mockResolvedValue(undefined)
		loadRegisteredConfiguration
			.mockReset()
			.mockResolvedValue({ configuration: {}, record: { redirectUri: 'http://127.0.0.1:1/callback' } })
		ensureMailboxLinked.mockReset().mockResolvedValue('mailbox-address')
		logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined)
	})

	afterEach(() => {
		logSpy.mockRestore()
	})

	it('links this device to its mailbox after the browser flow, and says where to see it', async () => {
		await runLoginCommand([])

		expect(runAuthorizationCodeLogin).toHaveBeenCalledTimes(1)
		expect(ensureMailboxLinked).toHaveBeenCalledTimes(1)
		const printed = logSpy.mock.calls.map((call: Array<unknown>) => String(call[0])).join('\n')
		expect(printed).toContain('mailbox-address')
		expect(printed).toContain('AIScelle tab')
	})

	it('links this device to its mailbox after the device flow too', async () => {
		await runLoginCommand(['--device'])

		expect(runDeviceLogin).toHaveBeenCalledTimes(1)
		expect(runAuthorizationCodeLogin).not.toHaveBeenCalled()
		expect(ensureMailboxLinked).toHaveBeenCalledTimes(1)
	})

	it('reports a failed link as an unfinished pairing, never as a failed sign-in', async () => {
		ensureMailboxLinked.mockRejectedValue(new Error('pairing_expired'))

		await expect(runLoginCommand([])).rejects.toThrow(/could not be registered on your mailbox/)
		await expect(runLoginCommand([])).rejects.toThrow(/pairing_expired/)
	})

	// The thrown error carries the whole instruction, expired pairing
	// included, so `pair` can print it without appending advice that would
	// contradict it (see pair-command.spec.ts).
	it('marks a failed link with its own type, and says what to do including when a new code is needed', async () => {
		ensureMailboxLinked.mockRejectedValue(new Error('pairing_expired'))

		const error = await runLoginCommand([]).catch((thrown: unknown) => thrown)

		expect(error).toBeInstanceOf(MailboxLinkError)
		expect(String(error)).toContain('npx @pliscelle/agent-mailbox-mcp login')
		expect(String(error)).toContain('npx @pliscelle/agent-mailbox-mcp pair')
	})
})
