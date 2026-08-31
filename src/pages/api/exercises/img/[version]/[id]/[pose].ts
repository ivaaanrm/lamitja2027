import type { APIRoute } from 'astro'
import { env } from 'cloudflare:workers'
import {
  CATALOG_VERSION,
  exerciseById,
  exerciseImageKey,
  resolvePose,
} from '@/lib/exercises/catalog'

export const prerender = false

const missing = () =>
  new Response(null, {
    status: 404,
    headers: { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' },
  })

/**
 * Streams one mirrored exercise illustration out of R2.
 *
 * Modelled on `/api/avatar/[version]`, and the shape is the same for the same reason: the
 * path is validated against something the server already knows *before* R2 is touched, so
 * the route cannot be used to probe the bucket, and the year-long immutable cache on a
 * successful URL is honest because the bytes under it can never change. There the "row" is
 * the athlete's `avatarKey`; here it is the compiled-in catalogue — the version segment
 * has to be this build's `CATALOG_VERSION`, the id has to be a real exercise, and the pose
 * has to be one that exercise actually has an illustration for.
 *
 * **The images are mirrored, never hotlinked.** This is a PWA whose whole claim is working
 * at a trailhead with no signal; a third-party origin in front of the service worker would
 * be an uncacheable dependency on somebody else's CDN in exactly the moment the app is
 * meant to still work. `scripts/exercises-populate.mjs` copies them into the bucket once,
 * byte for byte (RepDB licence term 5 — no derivation of any kind, generative or
 * otherwise), and this route is the only way back out.
 *
 * ## Two deliberate divergences from the avatar route
 *
 * **No `vary: Cookie`.** An avatar URL is one athlete's, so its response varies by who
 * asked; these bytes are the same illustration for every athlete on the deployment. The
 * Cache API honours `Vary`, so declaring it would make every re-login miss every entry in
 * `lm-media` and re-download the lot. `private` alone already keeps shared caches out.
 * Do not "fix" this back.
 *
 * **`card` is a pose the catalogue does not have.** It is the alias the UI asks for when
 * it does not know which poses exist — a session's payload carries an id and a name, never
 * a pose list — and it resolves here, server-side, to `peak` for a movement and `main` for
 * a hold. One place handles the two shapes RepDB's `images.flat` comes in.
 *
 * The extension comes from the *path* and never from R2's metadata, like the avatar route:
 * under `nosniff` the declared content type is the browser's only answer to what the bytes
 * are, so it has to be the thing that was validated.
 */
export const GET: APIRoute = async ({ request, params }) => {
  if (params.version !== CATALOG_VERSION) return missing()

  const exercise = params.id ? exerciseById(params.id) : undefined
  if (!exercise) return missing()

  const named = /^([a-z]+)\.webp$/.exec(params.pose ?? '')?.[1]
  const pose = named ? resolvePose(exercise, named) : null
  if (!pose) return missing()

  const object = await env.AVATARS.get(exerciseImageKey(exercise.id, pose), {
    onlyIf: request.headers,
  })
  if (!object) return missing()

  const headers = new Headers()
  object.writeHttpMetadata(headers)
  headers.set('cache-control', 'private, max-age=31536000, immutable')
  headers.set('content-type', 'image/webp')
  headers.set('etag', object.httpEtag)
  headers.set('x-content-type-options', 'nosniff')

  if (!('body' in object)) return new Response(null, { status: 304, headers })

  headers.set('content-length', String(object.size))
  return new Response(object.body, { headers })
}
