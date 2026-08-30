import { afterEach, describe, expect, it } from 'vitest'
import {
	AGENT_MAILBOX_OAUTH_SCOPE,
	MAILBOX_READ_SCOPE,
	MAILBOX_WRITE_SCOPE,
	agentMailboxResourceIdentifier,
} from '../src/oauth/scopes.js'

describe('agentMailboxResourceIdentifier', () => {
	afterEach(() => {
		delete process.env.AISCELLE_BACKEND_URL
	})

	it('matches the exact string the backend computes (BACKEND_HOSTNAME + "/agent-mailbox", no double slash)', () => {
		expect(agentMailboxResourceIdentifier()).toBe('https://api.pliscelle.com/agent-mailbox')
	})

	it('tracks a non-default backend origin without introducing a double slash', () => {
		process.env.AISCELLE_BACKEND_URL = 'http://localhost:3333'
		expect(agentMailboxResourceIdentifier()).toBe('http://localhost:3333/agent-mailbox')
	})
})

describe('scope constants', () => {
	it('mirrors the two scope strings the backend defines', () => {
		expect(MAILBOX_READ_SCOPE).toBe('mailbox:read')
		expect(MAILBOX_WRITE_SCOPE).toBe('mailbox:write')
		expect(AGENT_MAILBOX_OAUTH_SCOPE).toBe('mailbox:read mailbox:write')
	})
})
