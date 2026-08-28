import type { APIRoute } from 'astro'
import { env } from 'cloudflare:workers'
import { avatarContentType, avatarUrl } from '@/lib/avatar'

export const prerender = false

const missing = () =>
  new Response(null, {
    status: 404,
    headers: { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' },
  })

/**
 * Streams only the signed-in athlete's current object.
 *
 * The version in the path has to be the one derived from their database row before R2 is
 * touched. Besides closing cross-athlete reads, that makes the year-long private cache
 * honest: bytes under a successful URL never change.
 */
export const GET: APIRoute = async ({ request, params, locals }) => {
  const user = locals.user!
  const key = user.avatarKey
  const version = params.version
  if (!key || !version || avatarUrl(user.id, key) !== `/api/avatar/${version}`) return missing()

  // Read from the path rather than from R2's metadata: `nosniff` makes this header the
  // browser's only answer to what the bytes are, and the extension is what was validated.
  const contentType = avatarContentType(version)
  if (!contentType) return missing()

  const object = await env.AVATARS.get(key, { onlyIf: request.headers })
  if (!object) return missing()

  const headers = new Headers()
  object.writeHttpMetadata(headers)
  headers.set('cache-control', 'private, max-age=31536000, immutable')
  headers.set('content-type', contentType)
  headers.set('etag', object.httpEtag)
  headers.set('vary', 'Cookie')
  headers.set('x-content-type-options', 'nosniff')

  if (!('body' in object)) return new Response(null, { status: 304, headers })

  headers.set('content-length', String(object.size))
  return new Response(object.body, { headers })
}
