import { afterEach, describe, expect, it } from 'vitest'
import {
	AGENT_MAILBOX_OAUTH_SCOPE,
	MAILBOX_READ_SCOPE,
	MAILBOX_WRITE_SCOPE,
	OFFLINE_ACCESS_SCOPE,
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
	it('mirrors the two mailbox scope strings the backend defines', () => {
		expect(MAILBOX_READ_SCOPE).toBe('mailbox:read')
		expect(MAILBOX_WRITE_SCOPE).toBe('mailbox:write')
	})

	/**
	 * Not cosmetic, and the reason this assertion exists at all: the server
	 * only accepts `refresh_token` in a client registration, and only ever
	 * issues one, when `offline_access` is part of what it offers and what the
	 * client asks for. Drop it here and pairing fails outright on the very
	 * first command, which is what happened in production on 2026-08-30.
	 */
	it('asks for offline access, without which no device can even pair', () => {
		expect(OFFLINE_ACCESS_SCOPE).toBe('offline_access')
		expect(AGENT_MAILBOX_OAUTH_SCOPE).toBe('mailbox:read mailbox:write offline_access')
		expect(AGENT_MAILBOX_OAUTH_SCOPE.split(' ')).toContain(OFFLINE_ACCESS_SCOPE)
	})
})
