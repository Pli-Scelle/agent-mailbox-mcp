import { describe, expect, it } from 'vitest'
import { UNATTENDED_FLAG, resolveUnattendedMode } from '../src/config/unattended-mode.js'

describe('resolveUnattendedMode', () => {
	it('is off by default', () => {
		expect(resolveUnattendedMode([], {})).toBe(false)
	})

	it('is on when the launch flag is present', () => {
		expect(resolveUnattendedMode([UNATTENDED_FLAG], {})).toBe(true)
	})

	it('is on when the environment variable is set to 1 or true', () => {
		expect(resolveUnattendedMode([], { PLISCELLE_MCP_UNATTENDED: '1' })).toBe(true)
		expect(resolveUnattendedMode([], { PLISCELLE_MCP_UNATTENDED: 'true' })).toBe(true)
	})

	it('is off for any other environment value, never guessed', () => {
		expect(resolveUnattendedMode([], { PLISCELLE_MCP_UNATTENDED: 'yes' })).toBe(false)
		expect(resolveUnattendedMode([], { PLISCELLE_MCP_UNATTENDED: 'TRUE' })).toBe(false)
		expect(resolveUnattendedMode([], { PLISCELLE_MCP_UNATTENDED: '' })).toBe(false)
	})

	it('ignores a flag that merely looks like the real one', () => {
		expect(resolveUnattendedMode(['--unattended-please'], {})).toBe(false)
	})
})
