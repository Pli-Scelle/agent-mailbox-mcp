/**
 * The single place every HTTP call this connector makes to the AIScelle
 * backend passes through. Two things happen here, on every request,
 * unconditionally: this package's own version is attached, which is what
 * lets the server refuse a version it no longer accepts, and a version
 * refusal (version-refusal.ts) is recognised and turned into
 * `PackageVersionRejectedError` before the caller ever sees the response.
 *
 * Used two ways: as `openid-client`'s `[customFetch]` (oauth/*.ts, so
 * every registration/authorization/token/device/revocation call carries
 * the header and honours a refusal), and directly, as `fetchBackend`, for
 * every call against the mailbox HTTP API itself.
 */
import { getPackageVersion } from './package-version.js'
import { PACKAGE_VERSION_HEADER, PackageVersionRejectedError, readVersionRefusal } from './version-refusal.js'

function withVersionHeader(headers: ConstructorParameters<typeof Headers>[0]): Headers {
	const merged = new Headers(headers)
	merged.set(PACKAGE_VERSION_HEADER, getPackageVersion())
	return merged
}

/**
 * Plain wrapper around the platform `fetch`, for calls this package makes
 * outside of `openid-client`, that is the mailbox API client. Mirrors
 * `openidClientFetch` below exactly; kept as a separate, simpler signature
 * because `RequestInit`/global `fetch` is what a plain HTTP client should
 * take, not `openid-client`'s narrower `CustomFetchOptions`.
 */
export async function fetchBackend(input: string | URL, init?: RequestInit): Promise<Response> {
	const response = await fetch(input, { ...init, headers: withVersionHeader(init?.headers) })

	const refusal = await readVersionRefusal(response)
	if (refusal) throw new PackageVersionRejectedError(refusal)

	return response
}

/**
 * `openid-client`'s `CustomFetch` shape (`(url, options) => Promise<Response>`,
 * `options.headers` a plain `Record<string, string>`, verified against
 * `openid-client@6.8.4`'s published types). Passed as the
 * `[customFetch]` discovery/registration option in oauth/*.ts so every
 * OAuth HTTP call this package makes goes through the same version check
 * as `fetchBackend` above.
 */
export async function openidClientFetch(url: string, options: RequestInit & { headers: Record<string, string> }) {
	const headers = withVersionHeader(options.headers)
	const response = await fetch(url, { ...options, headers })

	const refusal = await readVersionRefusal(response)
	if (refusal) throw new PackageVersionRejectedError(refusal)

	return response
}
