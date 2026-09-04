/**
 * The AIScelle backend origin this connector talks to. Not configurable
 * as a general setting, but a fixed production default with an escape
 * hatch is standard practice for a publicly distributed CLI, and this
 * product already runs a preprod origin on the same domain shape
 * (`api.preprod.pliscelle.com`) that a maintainer legitimately needs to
 * point this connector at while testing a change that has not reached
 * production yet.
 *
 * `api.pliscelle.com` / `app.pliscelle.com` verified at the code: this
 * product already runs this API/SPA subdomain split.
 */
const DEFAULT_BACKEND_URL = 'https://api.pliscelle.com'
const BACKEND_URL_ENV_VAR = 'AISCELLE_BACKEND_URL'

export function resolveBackendUrl(): URL {
	const override = process.env[BACKEND_URL_ENV_VAR]
	const raw = override && override.trim().length > 0 ? override.trim() : DEFAULT_BACKEND_URL

	let url: URL
	try {
		url = new URL(raw)
	} catch {
		throw new Error(
			`${BACKEND_URL_ENV_VAR} is set to "${raw}", which is not a valid URL. Unset it to use the default (${DEFAULT_BACKEND_URL}), or fix it.`,
		)
	}

	if (url.protocol !== 'https:' && url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') {
		// This connector already accepts the seed and refresh token sitting
		// in clear on disk; it does not follow that it should also accept
		// sending either of them over plain HTTP to a non-loopback host.
		// Loopback stays allowed so a maintainer can point this at a local
		// backend during development.
		throw new Error(
			`${BACKEND_URL_ENV_VAR} ("${raw}") must use https, unless it points at localhost/127.0.0.1 for local development.`,
		)
	}

	return url
}
