/** The one avatar variant the app stores and renders. */
export const AVATAR_SIZE_PX = 512

/** The optimized request body, not the source photo selected on the phone. */
export const MAX_AVATAR_BYTES = 512 * 1024

/** Reject unusually large originals before asking the browser to decode them. */
export const MAX_AVATAR_SOURCE_BYTES = 20 * 1024 * 1024

/**
 * The two encodings an avatar may be stored in, and the extension each one is keyed under.
 *
 * WebP is what the app wants and what nearly every browser produces. WebKit is the
 * exception and it fails *silently*: `canvas.toBlob(cb, 'image/webp')` is spec'd to fall
 * back to PNG for a type it cannot encode, so on an iPhone the optimizer used to hand back
 * a PNG blob, the "is this WebP" check rejected it at every quality, and the athlete was
 * told their photo could not be compressed — every photo, every time. JPEG is the fallback
 * because it is the one lossy encoder every browser has; PNG at 512 px is lossless and
 * routinely larger than the 512 KB the endpoint accepts, so falling back to *that* would
 * only move the failure one step later.
 */
export const AVATAR_FORMATS = {
  'image/webp': 'webp',
  'image/jpeg': 'jpg',
} as const

export type AvatarContentType = keyof typeof AVATAR_FORMATS

const VERSION =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(?:webp|jpg)$/

/** The stored extension is what a later `GET` answers with; never sniff the bytes back. */
export function avatarContentType(version: string): AvatarContentType | null {
  if (!VERSION.test(version)) return null
  return version.endsWith('.webp') ? 'image/webp' : 'image/jpeg'
}

/** R2 keys are generated from the authenticated id, never from a request path. */
export function avatarKey(userId: string, version: string): string {
  if (!VERSION.test(version)) throw new Error('Invalid avatar version')
  return `avatars/${userId}/${version}`
}

/** The client sees an app URL, never the bucket key. */
export function avatarUrl(userId: string, key: string | null): string | null {
  if (!key) return null
  const prefix = `avatars/${userId}/`
  const version = key.startsWith(prefix) ? key.slice(prefix.length) : ''
  return VERSION.test(version) ? `/api/avatar/${version}` : null
}

/**
 * Reads a small request body without trusting `Content-Length`.
 *
 * The upload is intentionally buffered because header validation needs random access, but
 * the stream is cancelled the byte it crosses the hard limit so an unbounded body never
 * becomes an unbounded Worker allocation.
 */
export async function readBoundedBody(
  body: ReadableStream<Uint8Array> | null,
  maxBytes = MAX_AVATAR_BYTES,
): Promise<Uint8Array | null> {
  if (!body) return null

  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let length = 0

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value) continue
      length += value.byteLength
      if (length > maxBytes) {
        await reader.cancel('Avatar exceeds the byte limit')
        return null
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }

  const bytes = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}

const ascii = (bytes: Uint8Array, at: number, text: string): boolean =>
  [...text].every((char, index) => bytes[at + index] === char.charCodeAt(0))

/** Dispatches to the parser for the one encoding the request declared. */
export function imageDimensions(
  bytes: Uint8Array,
  contentType: AvatarContentType,
): { width: number; height: number } | null {
  return contentType === 'image/webp' ? webpDimensions(bytes) : jpegDimensions(bytes)
}

/**
 * Returns the dimensions declared by a structurally bounded WebP container.
 *
 * Supports the three WebP image headers (VP8, VP8L and VP8X). This is not an image
 * decoder; the browser already did that before upload. It is the server boundary that
 * prevents a forged content type or a tiny compressed image with enormous dimensions
 * from becoming the object every header later asks a browser to decode.
 */
export function webpDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.byteLength < 20 || !ascii(bytes, 0, 'RIFF') || !ascii(bytes, 8, 'WEBP')) return null

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (view.getUint32(4, true) + 8 !== bytes.byteLength) return null

  let chunkAt = 12
  while (chunkAt + 8 <= bytes.byteLength) {
    const size = view.getUint32(chunkAt + 4, true)
    const dataAt = chunkAt + 8
    if (dataAt + size > bytes.byteLength) return null

    if (ascii(bytes, chunkAt, 'VP8X') && size >= 10) {
      const width = 1 + bytes[dataAt + 4]! + (bytes[dataAt + 5]! << 8) + (bytes[dataAt + 6]! << 16)
      const height = 1 + bytes[dataAt + 7]! + (bytes[dataAt + 8]! << 8) + (bytes[dataAt + 9]! << 16)
      return { width, height }
    }

    if (ascii(bytes, chunkAt, 'VP8L') && size >= 5 && bytes[dataAt] === 0x2f) {
      const width = 1 + bytes[dataAt + 1]! + ((bytes[dataAt + 2]! & 0x3f) << 8)
      const height =
        1 +
        ((bytes[dataAt + 2]! & 0xc0) >> 6) +
        (bytes[dataAt + 3]! << 2) +
        ((bytes[dataAt + 4]! & 0x0f) << 10)
      return { width, height }
    }

    if (
      ascii(bytes, chunkAt, 'VP8 ') &&
      size >= 10 &&
      bytes[dataAt + 3] === 0x9d &&
      bytes[dataAt + 4] === 0x01 &&
      bytes[dataAt + 5] === 0x2a
    ) {
      const width = view.getUint16(dataAt + 6, true) & 0x3fff
      const height = view.getUint16(dataAt + 8, true) & 0x3fff
      return width > 0 && height > 0 ? { width, height } : null
    }

    chunkAt = dataAt + size + (size % 2)
  }

  return null
}

/**
 * Returns the dimensions declared by a structurally walked JPEG's frame header.
 *
 * Same contract as `webpDimensions`: not a decoder, only the server-side boundary that
 * keeps a forged content type or a decompression bomb out of the bucket. The segment walk
 * refuses rather than resynchronises — anything that is not a marker where a marker has to
 * be is treated as "not a JPEG", and the scan (`SOS`) is the end of the search, since every
 * frame header legal here precedes it.
 */
export function jpegDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.byteLength < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let at = 2

  while (at + 1 < bytes.byteLength) {
    if (bytes[at] !== 0xff) return null
    // Any number of 0xFF fill bytes may pad the gap before a marker.
    while (at + 1 < bytes.byteLength && bytes[at + 1] === 0xff) at += 1

    const marker = bytes[at + 1]!
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      at += 2
      continue
    }
    if (marker === 0xd9 || marker === 0xda) return null

    if (at + 4 > bytes.byteLength) return null
    const size = view.getUint16(at + 2)
    if (size < 2 || at + 2 + size > bytes.byteLength) return null

    const isFrame =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
    if (isFrame) {
      if (size < 7) return null
      const height = view.getUint16(at + 5)
      const width = view.getUint16(at + 7)
      return width > 0 && height > 0 ? { width, height } : null
    }

    at += 2 + size
  }

  return null
}
