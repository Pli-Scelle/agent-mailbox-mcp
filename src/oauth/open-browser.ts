/**
 * Best-effort system browser opener, no dependency added for it: three
 * platforms, three well-known commands. Failure here is never fatal --
 * `authorization-code-flow.ts` always prints the URL as well, so a
 * headless machine or a platform this function does not recognise still
 * lets the human complete the flow by copying the URL themselves.
 */
import { spawn } from 'node:child_process'

export function openInSystemBrowser(url: string): void {
	try {
		const [command, args] =
			process.platform === 'darwin'
				? ['open', [url]]
				: process.platform === 'win32'
					? ['cmd', ['/c', 'start', '""', url]]
					: ['xdg-open', [url]]

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
