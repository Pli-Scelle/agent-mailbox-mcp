/**
 * Where this connector keeps its local state: the seed, the tokens, the
 * backend address, the anti-injection policy switch's state, the
 * locally ratified sender allowlist, and the current conversation's
 * elicitation state. This module only produces the OAuth client
 * registration record and the token pair; the seed, kill-switch state,
 * ratified allowlist and elicitation store belong to the modules that
 * build the tools and the cryptography.
 *
 * XDG Base Directory on Linux/macOS (`$XDG_CONFIG_HOME` or
 * `~/.config`), `%APPDATA%` on Windows: this is the same convention most
 * CLI OAuth tools in this ecosystem already follow (gh, aws), chosen over
 * inventing a bespoke path so this connector's directory shows up where a
 * user (or their backup tooling) already expects application config to
 * live.
 */
import { homedir } from 'node:os'
import { join } from 'node:path'

const APP_DIR_NAME = 'pliscelle-mcp'

export function resolveConfigDir(): string {
	if (process.platform === 'win32') {
		const appData = process.env.APPDATA
		if (appData && appData.trim().length > 0) return join(appData, APP_DIR_NAME)
		return join(homedir(), 'AppData', 'Roaming', APP_DIR_NAME)
	}

	const xdgConfigHome = process.env.XDG_CONFIG_HOME
	if (xdgConfigHome && xdgConfigHome.trim().length > 0) return join(xdgConfigHome, APP_DIR_NAME)
	return join(homedir(), '.config', APP_DIR_NAME)
}

export function clientRecordPath(): string {
	return join(resolveConfigDir(), 'client.json')
}

export function tokenStorePath(): string {
	return join(resolveConfigDir(), 'tokens.json')
}
