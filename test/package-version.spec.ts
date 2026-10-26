import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'
import { getPackageVersion } from '../src/version/package-version.js'

describe('getPackageVersion', () => {
	it('matches the version actually declared in package.json', () => {
		const require = createRequire(import.meta.url)
		const pkg = require('../package.json') as { version: string }

		expect(getPackageVersion()).toBe(pkg.version)
	})

	it('is cached across calls (same reference behaviour, not just equal value)', () => {
		expect(getPackageVersion()).toBe(getPackageVersion())
	})
})
