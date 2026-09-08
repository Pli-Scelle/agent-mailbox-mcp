import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { MessageDetailResponse, MessageHeaderEntry } from '../src/api/wire-types.js'
import {
	deriveMailboxKeys,
	encodeKeyMaterial,
	encryptBlock,
	generateContentKey,
	sealContentKey,
	signEnvelope,
} from '../src/crypto/envelope-crypto.js'
import { loadMailboxIdentity } from '../src/crypto/mailbox-identity.js'
import { encodeBodyPlaintext, encodeHeaderPlaintext } from '../src/crypto/message-plaintext.js'
import { markRatifiedLocally, reconcileAllowlistWithServer } from '../src/trust/allowlist-store.js'
import { MessageRejectedError, openMessage, openMessageHeader } from '../src/trust/resolve-trust.js'

/**
 * End-to-end exercise, against this package's real crypto and real
 * local-store code (not a mock of either), of the rule that trust is
 * resolved purely from what this device has locally ratified: a device
 * seed is genuinely generated (crypto/seed-store.ts, lazily, via the
 * isolated XDG_CONFIG_HOME below), a message is genuinely signed and
 * sealed by a separate simulated sender device, and the server-reported
 * sender id and trust level never enter the decision -- exactly the
 * invariant tools/inbox.ts, tools/read.ts and resources/sensitive-
 * message-resource.ts depend on.
 */
describe('trust/resolve-trust.ts, end to end', () => {
	let dir: string
	let previousXdgConfigHome: string | undefined
	let sender: ReturnType<typeof deriveMailboxKeys>
	let recipientAddress: string

	beforeAll(async () => {
		dir = await mkdtemp(join(tmpdir(), 'aiscelle-mcp-resolve-trust-test-'))
		previousXdgConfigHome = process.env.XDG_CONFIG_HOME
		process.env.XDG_CONFIG_HOME = dir

		const identity = await loadMailboxIdentity() // Lazily generates this "device"'s seed inside `dir`.
		recipientAddress = identity.address
		sender = deriveMailboxKeys(randomBytes(32)) // A separate, simulated sender device.
	})

	afterAll(async () => {
		if (previousXdgConfigHome === undefined) delete process.env.XDG_CONFIG_HOME
		else process.env.XDG_CONFIG_HOME = previousXdgConfigHome
		await rm(dir, { recursive: true, force: true })
	})

	async function buildEnvelope(params: { title: string; body: string; sensitive?: boolean }) {
		const identity = await loadMailboxIdentity()
		const contentKey = generateContentKey()
		const now = new Date()

		const header = encryptBlock(
			contentKey,
			encodeHeaderPlaintext({
				title: params.title,
				sensitive: params.sensitive ?? false,
				bodyByteLength: Buffer.byteLength(params.body, 'utf8'),
				sentAt: now.toISOString(),
			}),
		)
		const body = encryptBlock(contentKey, encodeBodyPlaintext({ text: params.body }))
		const { sealedKey, ephemeralPublicKey } = sealContentKey(identity.keys.x25519.publicKeyRaw, contentKey)

		const messageUid = randomUUID()
		const requestedExpiresAt = now.toISOString()
		const freshnessTimestamp = now.toISOString()

		const signature = signEnvelope(sender.ed25519.privateKey, {
			recipientAddress,
			messageUid,
			headerCiphertext: header.ciphertext,
			bodyCiphertext: body.ciphertext,
			requestedExpiresAt,
			freshnessTimestamp,
		})

		const common = {
			id: 'message-' + messageUid,
			messageUid,
			headerCiphertext: encodeKeyMaterial(header.ciphertext),
			headerIv: encodeKeyMaterial(header.iv),
			sealedKey: encodeKeyMaterial(sealedKey),
			ephemeralPublicKey: encodeKeyMaterial(ephemeralPublicKey),
			signature: encodeKeyMaterial(signature),
			requestedExpiresAt,
			freshnessTimestamp,
			bodyCiphertextSha256: encodeKeyMaterial(createHash('sha256').update(body.ciphertext).digest()),
			byteSize: header.ciphertext.length + body.ciphertext.length,
			maxReads: -1,
			readCount: 0,
			expiresAt: new Date(now.getTime() + 86_400_000).toISOString(),
			deliveredAt: null,
			status: 'pending' as const,
			createdAt: now.toISOString(),
		}

		const headerEntry: MessageHeaderEntry = common
		const detail: MessageDetailResponse = {
			...common,
			bodyCiphertext: encodeKeyMaterial(body.ciphertext),
			bodyIv: encodeKeyMaterial(body.iv),
		}
		return { headerEntry, detail }
	}

	it('rejects a message from a sender key unknown to this device (no key verifies it, so it is rejected)', async () => {
		const { detail } = await buildEnvelope({ title: 'Hi', body: 'unauthorized sender' })
		await expect(openMessage(detail)).rejects.toThrow(MessageRejectedError)
	})

	it('treats a known but unratified sender as data even when configured as instruction server-side', async () => {
		await reconcileAllowlistWithServer([
			{
				id: 'sender-unratified',
				senderAddress: 'aisc_sender_unratified',
				senderPublicKeyEd25519: encodeKeyMaterial(sender.ed25519.publicKeyRaw),
				trustLevel: 'instruction',
				label: 'Not yet ratified',
				isActive: true,
			},
		])

		const { detail, headerEntry } = await buildEnvelope({ title: 'Do the thing', body: 'please act on this' })

		const opened = await openMessage(detail)
		expect(opened.trustLevel).toBe('data')
		expect(opened.isRatified).toBe(false)
		expect(opened.bodyText).toBe('please act on this')

		const openedHeader = await openMessageHeader(headerEntry)
		expect(openedHeader.trustLevel).toBe('data')
		expect(openedHeader.header.title).toBe('Do the thing')
	})

	it('grants the configured trust level once ratified on this device, and the server-reported sender_id/trust_level never enters the decision', async () => {
		await markRatifiedLocally('sender-unratified')

		const { detail } = await buildEnvelope({ title: 'Ratified now', body: 'trusted content' })
		const opened = await openMessage(detail)
		expect(opened.trustLevel).toBe('instruction')
		expect(opened.isRatified).toBe(true)
	})
})
