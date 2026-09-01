/**
 * The connector's own version, read from `package.json` at runtime rather
 * than hardcoded, so a build never drifts from what actually ships. The
 * server refuses cleanly a package that is too old rather than letting it
 * drift, plus enforces a version blocklist independent of age. Both
 * require the server to know which version is talking to it on every
 * call -- `attachPackageVersionHeader` (backend-client.ts) is what
 * carries this value there.
 *
 * `createRequire` + a bounded upward directory walk, not a JSON import
 * attribute (`import pkg from '../package.json' with { type: 'json' }`):
 * that syntax only stabilized in Node 22, and this package's own
 * `engines.node` is ">=20" (broader compatibility for whatever runtime an
 * agentic host bundles). The walk is bounded and looks for this exact
 * package's name so it can never silently pick up an unrelated
 * `package.json` from a parent directory of a consumer's own project.
 */
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const PACKAGE_NAME = '@pliscelle/agent-mailbox-mcp'
const MAX_WALK_DEPTH = 6

let cachedVersion: string | undefined

function readOwnPackageVersion(): string {
	const require = createRequire(import.meta.url)
	let dir = dirname(fileURLToPath(import.meta.url))

	for (let depth = 0; depth < MAX_WALK_DEPTH; depth += 1) {
		const candidate = join(dir, 'package.json')
		try {
			const pkg = require(candidate) as { name?: string; version?: string }
			if (pkg.name === PACKAGE_NAME && typeof pkg.version === 'string') {
				return pkg.version
			}
		} catch {
			// Not found at this level, or not readable: keep walking up.
		}
		const parent = dirname(dir)
		if (parent === dir) break
		dir = parent
	}

	throw new Error(
		`Could not locate ${PACKAGE_NAME}'s own package.json to read its version (searched ${MAX_WALK_DEPTH} directories up from the compiled module). This points at a broken install, not a code path to work around silently.`,
	)
}

/** Cached: this never changes for the lifetime of the process. */
export function getPackageVersion(): string {
	cachedVersion ??= readOwnPackageVersion()
	return cachedVersion
}
