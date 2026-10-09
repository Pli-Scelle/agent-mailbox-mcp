/**
 * Real MCP protocol round trip (same approach as mcp-tools-integration.spec.ts)
 * proving issue #984's connector-side requirement end to end: once this
 * device's access is definitively lost, the server stays up, `inbox` (like
 * every other tool routing through `api/mailbox-client.ts`'s
 * `authorizedFetch`) answers with an explicit MCP tool error naming the
 * repair command instead of an empty result, and the new `access_status`
 * tool reports the same fact in a structured, queryable shape.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ResponseBodyError } from 'openid-client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetRefreshBackoffForTests } from '../src/oauth/refresh-backoff.js'
import { type TokenRecord, writeTokenRecord } from '../src/oauth/token-store.js'
import { createAgentMailboxServer } from '../src/server/create-server.js'
import { registerAgentMailboxTools } from '../src/server/register-agent-mailbox-tools.js'

const loadRegisteredConfiguration = vi.fn()
vi.mock('../src/oauth/discovery.js', () => ({
	loadRegisteredConfiguration: (...args: Array<unknown>) => loadRegisteredConfiguration(...(args as [])),
}))

const refreshTokenGrant = vi.fn()
vi.mock('openid-client', async () => {
	const actual = await vi.importActual<typeof import('openid-client')>('openid-client')
	return {
		...actual,
		refreshTokenGrant: (...args: Array<unknown>) => refreshTokenGrant(...(args as [])),
	}
})

function expiringRecord(overrides: Partial<TokenRecord> = {}): TokenRecord {
	return {
		accessToken: 'stale-at',
		refreshToken: 'rt-1',
		scope: 'mailbox:read',
		expiresAt: new Date(Date.now() - 1_000).toISOString(),
		obtainedAt: new Date(Date.now() - 3_600_000).toISOString(),
		...overrides,
	}
}

function invalidGrantError(): ResponseBodyError {
	return new ResponseBodyError('invalid_grant', {
		cause: { error: 'invalid_grant', error_description: 'refresh token revoked' },
		response: new Response('{}', { status: 400 }),
	})
}

async function connectClient(server: McpServer) {
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
	const client = new Client({ name: 'test-client', version: '0.0.0' }, { capabilities: {} })
	await Promise.all([client.connect(clientTransport), server.connect(serverTransport)])
	return client
}

describe('tool calls after AIScelle access is lost (issue #984)', () => {
	let dir: string
	let previousXdgConfigHome: string | undefined

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), 'aiscelle-mcp-access-lost-test-'))
		previousXdgConfigHome = process.env.XDG_CONFIG_HOME
		process.env.XDG_CONFIG_HOME = dir

		refreshTokenGrant.mockReset()
		loadRegisteredConfiguration.mockReset()
		loadRegisteredConfiguration.mockResolvedValue({
			configuration: {},
			record: {
				clientId: 'device-1',
				redirectUri: 'http://127.0.0.1:1/cb',
				registeredAt: new Date().toISOString(),
			},
		})
		resetRefreshBackoffForTests()
	})

	afterEach(async () => {
		if (previousXdgConfigHome === undefined) delete process.env.XDG_CONFIG_HOME
		else process.env.XDG_CONFIG_HOME = previousXdgConfigHome
		await rm(dir, { recursive: true, force: true })
	})

	it('answers a tool call with an explicit MCP error naming the repair command, never an empty result', async () => {
		await writeTokenRecord(expiringRecord())
		refreshTokenGrant.mockRejectedValue(invalidGrantError())

		const server = createAgentMailboxServer()
		registerAgentMailboxTools(server, { unattended: false })
		const client = await connectClient(server)

		const result = await client.callTool({ name: 'inbox', arguments: {} })

		expect(result.isError).toBe(true)
		expect(result.content).toEqual([
			{ type: 'text', text: expect.stringContaining('npx @pliscelle/agent-mailbox-mcp login') },
		])

		await client.close()
		await server.close()
	})

	it('access_status reports access lost with the date and the repair command', async () => {
		await writeTokenRecord(expiringRecord())
		refreshTokenGrant.mockRejectedValue(invalidGrantError())

		const server = createAgentMailboxServer()
		registerAgentMailboxTools(server, { unattended: false })
		const client = await connectClient(server)

		const result = await client.callTool({ name: 'access_status', arguments: {} })

		expect(result.isError).toBeFalsy()
		expect(result.structuredContent).toMatchObject({
			status: 'lost',
			reason: 'invalid_grant',
			repairCommand: 'npx @pliscelle/agent-mailbox-mcp login',
		})
		expect(typeof (result.structuredContent as Record<string, unknown>).lostSince).toBe('string')

		await client.close()
		await server.close()
	})

	it('access_status reports a valid session without ever reaching the token endpoint', async () => {
		await writeTokenRecord({
			accessToken: 'fresh-at',
			refreshToken: 'rt-1',
			scope: 'mailbox:read',
			expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
			obtainedAt: new Date().toISOString(),
		})

		const server = createAgentMailboxServer()
		registerAgentMailboxTools(server, { unattended: false })
		const client = await connectClient(server)

		const result = await client.callTool({ name: 'access_status', arguments: {} })

		expect(result.isError).toBeFalsy()
		expect(result.structuredContent).toEqual({ status: 'valid' })
		expect(refreshTokenGrant).not.toHaveBeenCalled()

		await client.close()
		await server.close()
	})
})
