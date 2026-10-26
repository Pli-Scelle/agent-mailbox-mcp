import { describe, expect, it } from 'vitest'
import { systemBrowserCommand } from '../src/oauth/open-browser.js'

const AUTHORIZATION_URL =
	'https://app.example.test/oauth/authorize?response_type=code&client_id=abc&redirect_uri=http%3A%2F%2F127.0.0.1%3A53682%2Fcallback&scope=mailbox%3Aread&state=xyz&code_challenge=def&code_challenge_method=S256'

/**
 * Issue #1940: `cmd /c start "" <url>` hands the URL to the command interpreter, which reads every
 * unquoted `&` as a command separator, so the browser opened the URL cut at its first `&`. The
 * URL must reach the opener as one argument no interpreter splits.
 */
describe('systemBrowserCommand', () => {
	it('on Windows, never routes the URL through the cmd interpreter, and passes it whole', () => {
		const { command, args } = systemBrowserCommand(AUTHORIZATION_URL, 'win32')

		expect(command.toLowerCase()).not.toBe('cmd')
		expect(args.at(-1)).toBe(AUTHORIZATION_URL)
		expect(args.filter((arg) => arg.includes('&'))).toEqual([AUTHORIZATION_URL])
	})

	it('on macOS and Linux, passes the URL whole as the only argument', () => {
		expect(systemBrowserCommand(AUTHORIZATION_URL, 'darwin')).toEqual({
			command: 'open',
			args: [AUTHORIZATION_URL],
		})
		expect(systemBrowserCommand(AUTHORIZATION_URL, 'linux')).toEqual({
			command: 'xdg-open',
			args: [AUTHORIZATION_URL],
		})
	})
})
