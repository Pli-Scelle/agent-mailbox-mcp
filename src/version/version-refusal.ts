/**
 * Wire contract for a version refusal. The behaviour is mandated (refuse
 * an outdated package cleanly, with a message that says what to install;
 * refuse a blocklisted version regardless of how recent it is, same
 * message shape) but no wire format for it exists anywhere else in this
 * package.
 *
 * This file is therefore this package's OWN proposal for that wire
 * format, not a transcription of something already decided elsewhere. It
 * is documented this explicitly so that whatever builds the enforcing
 * side (checking `PACKAGE_VERSION_HEADER` against a minimum version and a
 * blocklist, on every AIScelle HTTP entry point -- OAuth token/
 * registration/device endpoints included, since a blocked version must be
 * cut off even if it never reaches the mailbox API) implements exactly
 * this shape rather than inventing a second, incompatible one.
 *
 * Chosen shape:
 *   - HTTP header `AIScelle-Package-Version: <semver>` sent by this
 *     package on every request it makes to the server (OAuth calls now,
 *     the mailbox API once it exists) -- `backend-client.ts` is the
 *     single place that attaches it.
 *   - HTTP 426 Upgrade Required on refusal: the one status code whose
 *     RFC 7231 §6.5.15 meaning ("resource requires a different protocol
 *     version") already matches this exactly, for both sub-cases (an old
 *     version needs upgrading; a blocklisted version needs replacing with
 *     a different one, which reads the same to a human as "upgrade").
 *   - JSON body carrying a closed `reason`, an optional `minVersion` (only
 *     meaningful for `too_old`), and a `message` already phrased for
 *     display: this refusal is a protocol-level notice about the
 *     PACKAGE, never mailbox content, so the rule against decrypted
 *     titles or bodies in logging has nothing to do with it and imposes
 *     no constraint here.
 */
import { z } from 'zod'

export const PACKAGE_VERSION_HEADER = 'AIScelle-Package-Version'

export const VERSION_REFUSAL_STATUS = 426

const versionRefusalBodySchema = z.object({
	error: z.literal('package_version_rejected'),
	reason: z.enum(['too_old', 'blocked']),
	minVersion: z.string().optional(),
	message: z.string(),
})

export type VersionRefusalReason = z.infer<typeof versionRefusalBodySchema>['reason']

export interface VersionRefusal {
	reason: VersionRefusalReason
	minVersion: string | undefined
	message: string
}

/**
 * Thrown by `versionedFetch` (backend-client.ts) the moment a response
 * matches the refusal contract above, before any OAuth or mailbox-API
 * caller gets a chance to interpret the response as anything else. A
 * package that swallowed this into a generic "request failed" would keep
 * retrying or surfacing a misleading error instead of the one thing that
 * matters here: telling the human what to install.
 */
export class PackageVersionRejectedError extends Error {
	readonly reason: VersionRefusalReason
	readonly minVersion: string | undefined

	constructor(refusal: VersionRefusal) {
		super(refusal.message)
		this.name = 'PackageVersionRejectedError'
		this.reason = refusal.reason
		this.minVersion = refusal.minVersion
	}
}

/**
 * Returns the parsed refusal when `response` matches the contract above,
 * `undefined` otherwise (a 426 from some unrelated cause, or any other
 * status, both fall through to the caller's normal error handling).
 * Never throws: a malformed body on an otherwise-426 response is not this
 * function's problem to raise, the caller's default error path already
 * covers "the backend said something we could not make sense of".
 */
export async function readVersionRefusal(response: Response): Promise<VersionRefusal | undefined> {
	if (response.status !== VERSION_REFUSAL_STATUS) return undefined

	let body: unknown
	try {
		body = await response.clone().json()
	} catch {
		return undefined
	}

	const parsed = versionRefusalBodySchema.safeParse(body)
	if (!parsed.success) return undefined

	return {
		reason: parsed.data.reason,
		minVersion: parsed.data.minVersion,
		message: parsed.data.message,
	}
}
