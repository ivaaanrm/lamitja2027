import type { AvatarContentType } from './avatar'
import { AVATAR_SIZE_PX, MAX_AVATAR_BYTES, MAX_AVATAR_SOURCE_BYTES } from './avatar'

interface DecodedImage {
  source: CanvasImageSource
  width: number
  height: number
  dispose: () => void
}

async function decodeWithImage(file: File): Promise<DecodedImage> {
  const url = URL.createObjectURL(file)
  const image = new Image()
  image.decoding = 'async'

  try {
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve()
      image.onerror = () => reject(new Error('No se reconoce el formato de esta imagen.'))
      image.src = url
    })
  } catch (error) {
    URL.revokeObjectURL(url)
    throw error
  }

  return {
    source: image,
    width: image.naturalWidth,
    height: image.naturalHeight,
    dispose: () => URL.revokeObjectURL(url),
  }
}

async function decode(file: File): Promise<DecodedImage> {
  if (typeof createImageBitmap === 'function') {
    try {
      const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' })
      return {
        source: bitmap,
        width: bitmap.width,
        height: bitmap.height,
        dispose: () => bitmap.close(),
      }
    } catch {
      // Safari's decoder supports more camera formats through `<img>` than ImageBitmap.
    }
  }
  return decodeWithImage(file)
}

/**
 * Encodes at the first quality that fits, and reports the type it actually got.
 *
 * `toBlob` answers a type it cannot encode with a PNG rather than with `null`, so the
 * returned blob's own type is the only trustworthy statement of what was produced.
 */
function encode(canvas: HTMLCanvasElement, type: AvatarContentType, quality: number) {
  return new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, quality))
}

async function compress(canvas: HTMLCanvasElement, type: AvatarContentType): Promise<Blob | null> {
  for (const quality of [0.82, 0.72, 0.62, 0.52]) {
    const blob = await encode(canvas, type, quality)
    if (!blob || blob.type !== type) return null
    if (blob.size <= MAX_AVATAR_BYTES) return blob
  }
  return null
}

/**
 * Decode, orient, center-crop and compress once, before a byte crosses the network.
 *
 * WebP is tried first and JPEG is the fallback, because WebKit silently encodes a PNG for
 * a type it does not support — which is not a browser this app can refuse, it is every
 * iPhone. The fallback re-paints rather than re-encoding the same canvas: JPEG has no
 * alpha channel, so a transparent PNG would otherwise arrive with black where the page
 * shows the athlete's initials through.
 */
export async function optimizeAvatar(file: File): Promise<Blob> {
  if (!file.type.startsWith('image/') || file.type === 'image/svg+xml') {
    throw new Error('Elige una foto JPG, PNG, WebP, AVIF o HEIC.')
  }
  if (file.size > MAX_AVATAR_SOURCE_BYTES) {
    throw new Error('La foto original no puede superar 20 MB.')
  }

  const decoded = await decode(file)
  try {
    if (decoded.width < 1 || decoded.height < 1) {
      throw new Error('La imagen no tiene unas dimensiones válidas.')
    }

    const canvas = document.createElement('canvas')
    canvas.width = AVATAR_SIZE_PX
    canvas.height = AVATAR_SIZE_PX
    const context = canvas.getContext('2d', { alpha: true })
    if (!context) throw new Error('Este navegador no puede preparar la foto.')

    context.imageSmoothingEnabled = true
    context.imageSmoothingQuality = 'high'

    const side = Math.min(decoded.width, decoded.height)
    const sourceX = (decoded.width - side) / 2
    const sourceY = (decoded.height - side) / 2

    const paint = (opaque: boolean) => {
      context.clearRect(0, 0, AVATAR_SIZE_PX, AVATAR_SIZE_PX)
      if (opaque) {
        context.fillStyle = '#ffffff'
        context.fillRect(0, 0, AVATAR_SIZE_PX, AVATAR_SIZE_PX)
      }
      context.drawImage(
        decoded.source,
        sourceX,
        sourceY,
        side,
        side,
        0,
        0,
        AVATAR_SIZE_PX,
        AVATAR_SIZE_PX,
      )
    }

    paint(false)
    const webp = await compress(canvas, 'image/webp')
    if (webp) return webp

    paint(true)
    const jpeg = await compress(canvas, 'image/jpeg')
    if (jpeg) return jpeg

    throw new Error('No se ha podido comprimir esta foto. Prueba con otra imagen.')
  } finally {
    decoded.dispose()
  }
}
