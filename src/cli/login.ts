/**
 * `pliscelle-mcp login`: exchanges this device's OAuth registration for a
 * token pair. Two mutually exclusive paths: authorization_code + PKCE
 * with a local browser (default), or the device flow for a machine with
 * none (`--device`).
 */
import { parseArgs } from 'node:util'
import { runAuthorizationCodeLogin } from '../oauth/authorization-code-flow.js'
import { runDeviceLogin } from '../oauth/device-flow.js'
import { loadRegisteredConfiguration } from '../oauth/discovery.js'

export async function runLoginCommand(argv: Array<string>): Promise<void> {
	const { values } = parseArgs({
		args: argv,
		options: { device: { type: 'boolean', default: false } },
		strict: true,
	})

	const { configuration, record } = await loadRegisteredConfiguration()

	if (values.device) {
		await runDeviceLogin({
			configuration,
			onVerificationPrompt: (prompt) => {
				console.log(
					`Open ${prompt.verificationUri} on any device with a browser and enter code: ${prompt.userCode}`,
				)
				if (prompt.verificationUriComplete) {
					console.log(`Or open directly: ${prompt.verificationUriComplete}`)
				}
				console.log('Waiting for approval...')
			},
		})
	} else {
		await runAuthorizationCodeLogin({
			configuration,
			redirectUri: record.redirectUri,
			onAuthorizationUrl: (url) => {
				console.log('Opening your browser to sign in. If it does not open automatically, visit:')
				console.log(url.toString())
			},
		})
	}

	console.log('Signed in. `pliscelle-mcp` (no arguments) now starts the MCP server for your agentic client.')
}
