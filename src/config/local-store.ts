/**
 * Generic read/write for this connector's local JSON state files (the
 * OAuth client record, the token pair). This connector's local file
 * always carries the seed in plaintext, with no passphrase; the refresh
 * token lands in the same file as the seed, so on the same exposure
 * surface. This is a residual risk stated and accepted deliberately
 * here, not one this module tries to close with client-side encryption
 * of its own invention.
 *
 * What this file DOES add, deliberately, is filesystem permission hygiene
 * ON WRITE: `0o600` (owner read/write only) on every write, inside a
 * `0o700` directory. That is ordinary OS-level access control, not a
 * passphrase or an encryption layer: it narrows who else on the same
 * machine can casually read the plaintext, it does not change the fact
 * that it is plaintext, so it does not contradict the residual-risk
 * statement above.
 *
 * What this file does NOT do, stated here because an earlier version of
 * this comment claimed it did: there is no check ON READ. `readJsonState`
 * below does `readFile` + `JSON.parse` + schema validation and nothing
 * else, no `stat`, no owner or mode verification. A local process running
 * as the same user (or as root) that replaces one of these files between
 * two calls is not detected, and the substituted content is accepted as
 * long as it parses and validates. Closing that would mean deciding what
 * to do on the platforms where mode bits do not carry the same meaning,
 * which is a decision this module does not make.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { z } from 'zod'

const OWNER_READ_WRITE_ONLY = 0o600
const OWNER_READ_WRITE_EXECUTE_ONLY = 0o700

/**
 * `undefined` when the file does not exist yet (first run) or fails
 * schema validation (a state file from an incompatible future/older
 * version of this package, or local corruption): both are treated as "no
 * state", never as a reason to crash the CLI, since the caller's own
 * flow (pairing, login) already knows how to (re)create the file.
 */
export async function readJsonState<T>(path: string, schema: z.ZodType<T>): Promise<T | undefined> {
	let raw: string
	try {
		raw = await readFile(path, 'utf8')
	} catch {
		return undefined
	}

	let parsed: unknown
	try {
		parsed = JSON.parse(raw)
	} catch {
		return undefined
	}

	const result = schema.safeParse(parsed)
	return result.success ? result.data : undefined
}

/**
 * Writes via a temp file + rename in the same directory, so a process
 * killed mid-write (a crash, a signal from the agentic host tearing down
 * the subprocess) can never leave a half-written token file that the next
 * read silently treats as valid JSON. `rename` within one directory is
 * atomic on every platform this package targets (POSIX rename(2); NTFS
 * MoveFileEx in the same volume, which Node's `fs.rename` uses on
 * Windows).
 */
export async function writeJsonState(path: string, value: unknown): Promise<void> {
	const dir = dirname(path)
	await mkdir(dir, { recursive: true, mode: OWNER_READ_WRITE_EXECUTE_ONLY })

	const tempPath = `${path}.${process.pid}.tmp`
	await writeFile(tempPath, `${JSON.stringify(value, null, '\t')}\n`, { mode: OWNER_READ_WRITE_ONLY })
	await rename(tempPath, path)
}
