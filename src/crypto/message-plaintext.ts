/**
 * The plaintext JSON shape carried inside the header and body envelope
 * blocks: the header carries the title, the timestamp, the sensitivity
 * flag and the body's byte length; the body carries the text. What these
 * blocks carry is fixed, not their concrete serialization: this is
 * entirely internal to the device side of the protocol (the server only
 * ever sees ciphertext), so this package defines it once, here, and both
 * `tools/send.ts` (encode) and
 * `tools/read.ts`/`resources/sensitive-message-resource.ts` (decode) share
 * it -- never two independent guesses at the same wire shape.
 */
import { z } from 'zod'

export const headerPlaintextSchema = z.object({
	title: z.string().max(200),
	/** The sender marks a message as sensitive at deposit time. The flag travels inside the encrypted header. */
	sensitive: z.boolean(),
	/** The header carries the body's byte length, so `inbox`/`search` never need the body block to report it. */
	bodyByteLength: z.number().int().nonnegative(),
	sentAt: z.string().datetime(),
})
export type HeaderPlaintext = z.infer<typeof headerPlaintextSchema>

export const bodyPlaintextSchema = z.object({
	text: z.string(),
})
export type BodyPlaintext = z.infer<typeof bodyPlaintextSchema>

export function encodeHeaderPlaintext(header: HeaderPlaintext): Buffer {
	return Buffer.from(JSON.stringify(header), 'utf8')
}

export function decodeHeaderPlaintext(raw: Buffer): HeaderPlaintext {
	const parsed: unknown = JSON.parse(raw.toString('utf8'))
	return headerPlaintextSchema.parse(parsed)
}

export function encodeBodyPlaintext(body: BodyPlaintext): Buffer {
	return Buffer.from(JSON.stringify(body), 'utf8')
}

export function decodeBodyPlaintext(raw: Buffer): BodyPlaintext {
	const parsed: unknown = JSON.parse(raw.toString('utf8'))
	return bodyPlaintextSchema.parse(parsed)
}
