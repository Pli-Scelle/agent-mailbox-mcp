/**
 * Best-effort system browser opener, no dependency added for it: three
 * platforms, three well-known commands. Failure here is never fatal:
 * `authorization-code-flow.ts` always prints the URL as well, so a
 * headless machine or a platform this function does not recognise still
 * lets the human complete the flow by copying the URL themselves.
 *
 * Windows goes through `rundll32 url.dll,FileProtocolHandler`, never
 * `cmd /c start`: the command interpreter reads every unquoted `&` as a
 * command separator, and an authorization URL carries several, so the
 * browser opened the URL cut at its first parameter (issue #1940).
 * `rundll32` receives the URL as one argument and no interpreter parses it.
 */
import { spawn } from 'node:child_process'

export interface BrowserCommand {
	command: string
	args: Array<string>
}

/** The command that opens `url` in the system browser on `platform`. */
export function systemBrowserCommand(url: string, platform: NodeJS.Platform = process.platform): BrowserCommand {
	if (platform === 'darwin') return { command: 'open', args: [url] }
	if (platform === 'win32') return { command: 'rundll32', args: ['url.dll,FileProtocolHandler', url] }
	return { command: 'xdg-open', args: [url] }
}

export function openInSystemBrowser(url: string): void {
	try {
		const { command, args } = systemBrowserCommand(url)
		const child = spawn(command, args, { stdio: 'ignore', detached: true })
		child.on('error', () => {
			// No system opener available (headless CI, minimal container):
			// the caller already prints the URL, nothing else to do here.
		})
		child.unref()
	} catch {
		// Same reasoning: printing the URL is the real fallback.
	}
}
