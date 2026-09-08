/**
 * Classifies a `refreshTokenGrant` failure (openid-client) as definitive
 * (replaying the exact same request can never succeed) or transitory,
 * worth retrying (issue #984: a device rejected with `invalid_grant` kept
 * replaying the same dead refresh token every fifteen seconds for days,
 * 11 191 calls in four days, all refused the same way).
 *
 * RFC 6749 section 5.2 defines exactly six error codes a token endpoint
 * answers a failed grant with: `invalid_request`, `invalid_client`,
 * `invalid_grant`, `unauthorized_client`, `unsupported_grant_type`,
 * `invalid_scope`. `refresh.ts`'s `callTokenEndpoint` resends the identical
 * `client_id`, `grant_type` and `refresh_token` on every attempt, so every
 * one of the six is definitive here: none of them depends on anything that
 * changes between two attempts of the exact same request, so a retry
 * reproduces the exact same verdict every time.
 *
 * A `ResponseBodyError` is only ever thrown for a response the server
 * answered as a well-formed OAuth error body (verified `oauth4webapi@3.8.6`,
 * the library openid-client re-exports it from): a network failure, a
 * timeout, or a 5xx from an edge proxy that never reaches `oidc-provider`'s
 * own error handling surfaces as a different error class entirely (a
 * `TypeError` for a transport failure, an `OperationProcessingError` for a
 * non-JSON body), never as a `ResponseBodyError`. Anything that is not a
 * `ResponseBodyError` carrying one of the six codes above is therefore
 * transitory by construction: `refresh-backoff.ts`'s growing, capped delay
 * is what already handles those.
 */
import { ResponseBodyError } from 'openid-client'

const DEFINITIVE_GRANT_ERROR_CODES: ReadonlySet<string> = new Set([
	'invalid_request',
	'invalid_client',
	'invalid_grant',
	'unauthorized_client',
	'unsupported_grant_type',
	'invalid_scope',
])

export function isDefinitiveGrantError(error: unknown): error is ResponseBodyError {
	return error instanceof ResponseBodyError && DEFINITIVE_GRANT_ERROR_CODES.has(error.error)
}
