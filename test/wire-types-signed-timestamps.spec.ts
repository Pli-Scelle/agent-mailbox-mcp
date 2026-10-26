import { describe, expect, it } from 'vitest'
import { messageDetailResponseSchema, messageListResponseSchema } from '../src/api/wire-types.js'

/**
 * Issue #1935: the two signed timestamps are returned exactly as the sender signed them, and the
 * server accepts a numeric offset on both. This entry is a real listing item the backend returned
 * for a deposit signed with offset timestamps (captured from
 * `apps/backend/tests/functional/agent_mailbox/agent_mailbox_signed_timestamp_offset.spec.ts`,
 * which proves the server returns both strings verbatim). One such entry used to fail the whole
 * page, the search and the pending count on this device.
 */
const SERVER_LISTING_ITEM = {
	id: '8d4cdca1-91cd-480a-97a5-abe2d281039b',
	messageUid: 'uid-offset-1791852288048-4rvkhktvoq8',
	headerCiphertext: 'b2Zmc2V0LXRlc3QtaGVhZGVyLWNpcGhlcnRleHQ=',
	headerIv: 'b2Zmc2V0LWl2LWhkcg==',
	// Base64 of the text `offset-sealed-key`, built here: written out, a secret scanner reads it as a key.
	sealedKey: Buffer.from('offset-sealed-key').toString('base64'),
	ephemeralPublicKey: 'b2Zmc2V0LWVwaGVtZXJhbC1rZXk=',
	signature: 'X3fi3EUmoW12yP45S4tmx2t4CShjS+Z2UXScCFt6x+FTW7dedwZzuYEGy/Xh8ij17ouBiXzqCG4qlDahXd4iBA==',
	requestedExpiresAt: '2026-10-14T02:44:48.135+02:00',
	freshnessTimestamp: '2026-10-13T06:14:48.136+05:30',
	bodyCiphertextSha256: '2Xm3Mz3UxuHZ9ToRVSjtVPgeRDMtkH8153/mDrTbm7g=',
	byteSize: 56,
	maxReads: -1,
	readCount: 0,
	expiresAt: '2026-10-14T00:44:48.298Z',
	deliveredAt: null,
	status: 'pending',
	createdAt: '2026-10-13T00:44:48.298Z',
}

describe('signed timestamps as the server returns them', () => {
	it('a listing page carrying offset signed timestamps is accepted, strings kept verbatim', () => {
		const parsed = messageListResponseSchema.safeParse({
			items: [SERVER_LISTING_ITEM],
			nextCursor: null,
			pendingCount: 1,
		})

		expect(parsed.success).toBe(true)
		expect(parsed.data?.items[0]?.requestedExpiresAt).toBe('2026-10-14T02:44:48.135+02:00')
		expect(parsed.data?.items[0]?.freshnessTimestamp).toBe('2026-10-13T06:14:48.136+05:30')
	})

	it('a message detail carrying offset signed timestamps is accepted', () => {
		const parsed = messageDetailResponseSchema.safeParse({
			...SERVER_LISTING_ITEM,
			bodyCiphertext: 'b2Zmc2V0LXRlc3QtYm9keS1jaXBoZXJ0ZXh0',
			bodyIv: 'b2Zmc2V0LWl2LWJvZHk=',
		})

		expect(parsed.success).toBe(true)
	})

	it('accepts any form the server stores for them, compact offset and no offset included', () => {
		for (const value of ['2026-10-13T02:00:00+0200', '2026-10-13T02:00:00', '2026-10-13T00:00:00.000Z']) {
			const parsed = messageListResponseSchema.safeParse({
				items: [{ ...SERVER_LISTING_ITEM, requestedExpiresAt: value, freshnessTimestamp: value }],
				nextCursor: null,
				pendingCount: 1,
			})
			expect(parsed.success).toBe(true)
		}
	})

	it('still refuses an entry missing a signed timestamp, as the server never lists one', () => {
		const parsed = messageListResponseSchema.safeParse({
			items: [{ ...SERVER_LISTING_ITEM, freshnessTimestamp: '' }],
			nextCursor: null,
			pendingCount: 1,
		})

		expect(parsed.success).toBe(false)
	})
})
