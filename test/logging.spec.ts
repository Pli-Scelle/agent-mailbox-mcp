import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { describe, expect, it, vi } from 'vitest'
import { logAgentMailboxEvent } from '../src/server/logging.js'

describe('logAgentMailboxEvent', () => {
	function buildServerWithSpy() {
		const server = new McpServer({ name: 'test', version: '0.0.0' }, { capabilities: { logging: {} } })
		const sendSpy = vi.spyOn(server.server, 'sendLoggingMessage').mockResolvedValue(undefined)
		return { server, sendSpy }
	}

	it('sends the event name and a timestamp, never a free-form message field', () => {
		const { server, sendSpy } = buildServerWithSpy()

		logAgentMailboxEvent(server, { event: 'session_authenticated', deviceId: 'device-123' })

		expect(sendSpy).toHaveBeenCalledTimes(1)
		const [params] = sendSpy.mock.calls[0]!
		expect(params.logger).toBe('aiscelle-mcp')
		expect(params.data).toMatchObject({ event: 'session_authenticated', deviceId: 'device-123' })
		expect((params.data as { timestamp: string }).timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/)
		// Closed-vocabulary check: no key on the emitted payload beyond what
		// the AgentMailboxLogEvent union declares for this case.
		expect(Object.keys(params.data as object).sort()).toEqual(['deviceId', 'event', 'timestamp'])
	})

	it('maps a version-rejection event to the error level', () => {
		const { server, sendSpy } = buildServerWithSpy()

		logAgentMailboxEvent(server, { event: 'package_version_rejected', reason: 'blocked', minVersion: undefined })

		const [params] = sendSpy.mock.calls[0]!
		expect(params.level).toBe('error')
	})

	it('maps server_started to the info level', () => {
		const { server, sendSpy } = buildServerWithSpy()

		logAgentMailboxEvent(server, {
			event: 'server_started',
			packageVersion: '0.1.0',
			protocolVersion: '2025-06-18',
		})

		const [params] = sendSpy.mock.calls[0]!
		expect(params.level).toBe('info')
	})

	it('never throws even if the transport rejects the notification', () => {
		const server = new McpServer({ name: 'test', version: '0.0.0' }, { capabilities: { logging: {} } })
		vi.spyOn(server.server, 'sendLoggingMessage').mockRejectedValue(new Error('no client connected'))

		expect(() => logAgentMailboxEvent(server, { event: 'session_authenticated', deviceId: 'x' })).not.toThrow()
	})
})
