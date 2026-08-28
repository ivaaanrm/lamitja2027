import { describe, expect, it } from 'vitest'
import {
  AVATAR_SIZE_PX,
  avatarKey,
  avatarUrl,
  readBoundedBody,
  webpDimensions,
} from '../../src/lib/avatar'

const writeAscii = (bytes: Uint8Array, at: number, text: string) => {
  for (let i = 0; i < text.length; i += 1) bytes[at + i] = text.charCodeAt(i)
}

function riff(chunk: 'VP8X' | 'VP8L' | 'VP8 ', data: Uint8Array): Uint8Array {
  const padded = data.byteLength + (data.byteLength % 2)
  const bytes = new Uint8Array(12 + 8 + padded)
  const view = new DataView(bytes.buffer)
  writeAscii(bytes, 0, 'RIFF')
  view.setUint32(4, bytes.byteLength - 8, true)
  writeAscii(bytes, 8, 'WEBP')
  writeAscii(bytes, 12, chunk)
  view.setUint32(16, data.byteLength, true)
  bytes.set(data, 20)
  return bytes
}

function vp8x(width: number, height: number): Uint8Array {
  const data = new Uint8Array(10)
  const w = width - 1
  const h = height - 1
  data.set([w & 0xff, (w >> 8) & 0xff, (w >> 16) & 0xff], 4)
  data.set([h & 0xff, (h >> 8) & 0xff, (h >> 16) & 0xff], 7)
  return riff('VP8X', data)
}

function vp8l(width: number, height: number): Uint8Array {
  const w = width - 1
  const h = height - 1
  return riff(
    'VP8L',
    new Uint8Array([
      0x2f,
      w & 0xff,
      ((w >> 8) & 0x3f) | ((h & 0x03) << 6),
      (h >> 2) & 0xff,
      (h >> 10) & 0x0f,
    ]),
  )
}

function vp8(width: number, height: number): Uint8Array {
  const data = new Uint8Array(10)
  const view = new DataView(data.buffer)
  data.set([0x9d, 0x01, 0x2a], 3)
  view.setUint16(6, width, true)
  view.setUint16(8, height, true)
  return riff('VP8 ', data)
}

describe('avatar object identity', () => {
  const userId = '4ecf9384-6e9e-4e5b-b238-8fb48cbf7b31'
  const version = '305543e4-aa56-4b09-b91a-e585fac104e9.webp'

  it('keeps the private key behind an authenticated app URL', () => {
    const key = avatarKey(userId, version)
    expect(key).toBe(`avatars/${userId}/${version}`)
    expect(avatarUrl(userId, key)).toBe(`/api/avatar/${version}`)
  })

  it('does not expose a key owned by a different athlete', () => {
    expect(avatarUrl('someone-else', avatarKey(userId, version))).toBeNull()
    expect(avatarUrl(userId, 'avatars/not-a-valid-key')).toBeNull()
  })
})

describe('WebP validation', () => {
  it.each([vp8x, vp8l, vp8])('reads the 512 px dimensions from every WebP header', (make) => {
    expect(webpDimensions(make(AVATAR_SIZE_PX, AVATAR_SIZE_PX))).toEqual({
      width: AVATAR_SIZE_PX,
      height: AVATAR_SIZE_PX,
    })
  })

  it('rejects a truncated or forged RIFF container', () => {
    const valid = vp8x(512, 512)
    expect(webpDimensions(valid.slice(0, -1))).toBeNull()

    valid[0] = 0
    expect(webpDimensions(valid)).toBeNull()
  })
})

describe('bounded avatar bodies', () => {
  const stream = (...chunks: number[][]) =>
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(new Uint8Array(chunk))
        controller.close()
      },
    })

  it('joins a body that stays inside the limit', async () => {
    await expect(readBoundedBody(stream([1, 2], [3, 4]), 4)).resolves.toEqual(
      new Uint8Array([1, 2, 3, 4]),
    )
  })

  it('stops as soon as a body crosses the limit', async () => {
    await expect(readBoundedBody(stream([1, 2], [3, 4, 5]), 4)).resolves.toBeNull()
  })

  it('distinguishes a missing body from an empty one', async () => {
    await expect(readBoundedBody(null, 4)).resolves.toBeNull()
    await expect(readBoundedBody(stream(), 4)).resolves.toEqual(new Uint8Array())
  })
})
