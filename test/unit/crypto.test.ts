import { describe, expect, it } from 'vitest'
import { decrypt, encrypt, randomToken, timingSafeEqual } from '@/lib/crypto'

/** A valid 256-bit key, base64 — the shape `openssl rand -base64 32` produces. */
const KEY = Buffer.alloc(32, 7).toString('base64')
const OTHER_KEY = Buffer.alloc(32, 9).toString('base64')

describe('encrypt/decrypt', () => {
  it('round-trips a token', async () => {
    const secret = 'a1b2c3d4e5f6-strava-refresh-token'
    expect(await decrypt(await encrypt(secret, KEY), KEY)).toBe(secret)
  })

  it('round-trips unicode and empty strings', async () => {
    for (const value of ['', 'ünïcodé ✓ 🏃', 'x'.repeat(4096)]) {
      expect(await decrypt(await encrypt(value, KEY), KEY)).toBe(value)
    }
  })

  it('produces a different ciphertext each time (random IV)', async () => {
    const a = await encrypt('same input', KEY)
    const b = await encrypt('same input', KEY)
    expect(a).not.toBe(b)
    // ...but both still decrypt, so the IV really is being carried in the payload.
    expect(await decrypt(a, KEY)).toBe(await decrypt(b, KEY))
  })

  it('fails to decrypt with the wrong key', async () => {
    await expect(decrypt(await encrypt('secret', KEY), OTHER_KEY)).rejects.toThrow()
  })

  it('fails to decrypt tampered ciphertext', async () => {
    // GCM is authenticated: flipping any byte must fail, not silently return garbage.
    const packed = await encrypt('secret', KEY)
    const bytes = Buffer.from(packed, 'base64')
    bytes[bytes.length - 1] ^= 0xff
    await expect(decrypt(bytes.toString('base64'), KEY)).rejects.toThrow()
  })

  it('rejects a key that is not 32 bytes', async () => {
    await expect(encrypt('x', Buffer.alloc(16, 1).toString('base64'))).rejects.toThrow(
      /must decode to 32 bytes/,
    )
  })
})

describe('timingSafeEqual', () => {
  it('matches identical strings and rejects everything else', () => {
    expect(timingSafeEqual('abc123', 'abc123')).toBe(true)
    expect(timingSafeEqual('abc123', 'abc124')).toBe(false)
    expect(timingSafeEqual('abc', 'abcd')).toBe(false)
    expect(timingSafeEqual('', '')).toBe(true)
  })
})

describe('randomToken', () => {
  it('is URL-safe and non-repeating', () => {
    const tokens = new Set(Array.from({ length: 100 }, () => randomToken(16)))
    expect(tokens.size).toBe(100)
    for (const token of tokens) expect(token).toMatch(/^[A-Za-z0-9_-]+$/)
  })
})
