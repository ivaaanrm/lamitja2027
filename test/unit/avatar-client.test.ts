import { afterEach, describe, expect, it, vi } from 'vitest'
import { AVATAR_SIZE_PX } from '../../src/lib/avatar'
import { optimizeAvatar } from '../../src/lib/avatar-client'

/**
 * The optimizer is the one piece of this app that runs against an image encoder rather
 * than against numbers, so the encoder is what these tests fabricate. WebKit is the case
 * that matters: it answers `toBlob(cb, 'image/webp')` with a PNG instead of refusing, and
 * every photo an iPhone picked used to die on that.
 */
type Recorded = { type: string; quality: number | undefined }

function install(encode: (type: string) => string | null) {
  const calls: Recorded[] = []
  const fills: string[] = []

  const context = {
    imageSmoothingEnabled: false,
    imageSmoothingQuality: 'low',
    fillStyle: '',
    clearRect: () => {},
    fillRect: () => fills.push(context.fillStyle),
    drawImage: () => {},
  }

  const canvas = {
    width: 0,
    height: 0,
    getContext: () => context,
    toBlob(callback: (blob: Blob | null) => void, type?: string, quality?: number) {
      calls.push({ type: type!, quality })
      const produced = encode(type!)
      callback(produced === null ? null : new Blob([new Uint8Array(64)], { type: produced }))
    },
  }

  vi.stubGlobal('document', { createElement: () => canvas })
  vi.stubGlobal('createImageBitmap', async () => ({ width: 1200, height: 900, close: () => {} }))
  return { calls, fills, canvas }
}

const photo = { type: 'image/jpeg', size: 3_000_000 } as File

afterEach(() => vi.unstubAllGlobals())

describe('avatar optimization', () => {
  it('keeps WebP where the browser can encode it', async () => {
    const { calls, fills, canvas } = install((type) => type)

    const blob = await optimizeAvatar(photo)

    expect(blob.type).toBe('image/webp')
    expect(calls).toEqual([{ type: 'image/webp', quality: 0.82 }])
    expect(canvas.width).toBe(AVATAR_SIZE_PX)
    expect(canvas.height).toBe(AVATAR_SIZE_PX)
    expect(fills).toEqual([])
  })

  it('falls back to JPEG on a browser that silently substitutes PNG', async () => {
    // WebKit's answer to an unsupported output type, which is not an error anywhere.
    const { calls, fills } = install((type) => (type === 'image/webp' ? 'image/png' : type))

    const blob = await optimizeAvatar(photo)

    expect(blob.type).toBe('image/jpeg')
    expect(calls.map((call) => call.type)).toEqual(['image/webp', 'image/jpeg'])
    // JPEG has no alpha, so the fallback repaints on an opaque ground first.
    expect(fills).toEqual(['#ffffff'])
  })

  it('falls back when the encoder returns nothing at all', async () => {
    install((type) => (type === 'image/webp' ? null : type))
    await expect(optimizeAvatar(photo)).resolves.toHaveProperty('type', 'image/jpeg')
  })

  it('only gives up when neither encoder produces its own format', async () => {
    install(() => 'image/png')
    await expect(optimizeAvatar(photo)).rejects.toThrow('No se ha podido comprimir')
  })

  it('refuses a source that is not a raster image', async () => {
    install((type) => type)
    await expect(optimizeAvatar({ type: 'image/svg+xml', size: 10 } as File)).rejects.toThrow(
      'Elige una foto',
    )
    await expect(optimizeAvatar({ type: 'image/jpeg', size: 21e6 } as File)).rejects.toThrow(
      '20 MB',
    )
  })
})
