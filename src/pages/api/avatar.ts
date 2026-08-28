import type { APIRoute } from 'astro'
import { env } from 'cloudflare:workers'
import { and, eq, isNull } from 'drizzle-orm'
import type { AvatarContentType } from '@/lib/avatar'
import {
  AVATAR_FORMATS,
  AVATAR_SIZE_PX,
  MAX_AVATAR_BYTES,
  avatarKey,
  avatarUrl,
  imageDimensions,
  readBoundedBody,
} from '@/lib/avatar'
import { json } from '@/lib/api'
import { createDb } from '@/lib/db/client'
import { users } from '@/lib/db/schema'

export const prerender = false

const tooLarge = () => json({ error: 'La foto optimizada no puede superar 512 KB' }, 413)

function logCleanupFailure(action: 'replace' | 'rollback' | 'remove', key: string, cause: unknown) {
  console.error(
    JSON.stringify({
      message: 'avatar object cleanup failed',
      action,
      key,
      error: cause instanceof Error ? cause.message : String(cause),
    }),
  )
}

/**
 * Replaces the authenticated athlete's avatar with one browser-optimized image.
 *
 * WebP or JPEG, because WebKit cannot encode the first — the declared type picks the
 * header parser, the stored extension and what a later `GET` answers with, so the three
 * can never disagree.
 *
 * The request never carries a user id. A fresh object key is written first and then won
 * into `users.avatar_key` with an optimistic condition against the middleware's snapshot.
 * Two uploads racing therefore produce one current object and one clean 409, not an
 * orphan or one athlete's photo under another athlete's URL.
 */
export const PUT: APIRoute = async ({ request, locals }) => {
  const user = locals.user!
  const contentType = request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
  if (!contentType || !Object.hasOwn(AVATAR_FORMATS, contentType)) {
    return json({ error: 'La foto tiene que llegar optimizada como WebP o JPEG' }, 415)
  }
  const format = contentType as AvatarContentType

  const declaredLength = Number(request.headers.get('content-length'))
  if (Number.isFinite(declaredLength) && declaredLength > MAX_AVATAR_BYTES) return tooLarge()
  if (!request.body) return json({ error: 'Falta la foto' }, 400)

  const bytes = await readBoundedBody(request.body)
  if (!bytes) return tooLarge()
  const dimensions = imageDimensions(bytes, format)
  if (dimensions?.width !== AVATAR_SIZE_PX || dimensions.height !== AVATAR_SIZE_PX) {
    return json({ error: `La foto optimizada tiene que medir ${AVATAR_SIZE_PX} × ${AVATAR_SIZE_PX} px` }, 400)
  }

  const version = `${crypto.randomUUID()}.${AVATAR_FORMATS[format]}`
  const key = avatarKey(user.id, version)
  await env.AVATARS.put(key, bytes, {
    httpMetadata: { contentType: format, contentDisposition: 'inline' },
    customMetadata: { userId: user.id },
  })

  const db = createDb(env.DB)
  const previousKey = user.avatarKey
  let updated: { id: string } | undefined
  try {
    ;[updated] = await db
      .update(users)
      .set({ avatarKey: key })
      .where(
        and(
          eq(users.id, user.id),
          previousKey === null ? isNull(users.avatarKey) : eq(users.avatarKey, previousKey),
        ),
      )
      .returning({ id: users.id })
  } catch (cause) {
    await env.AVATARS.delete(key).catch((cleanupCause) => logCleanupFailure('rollback', key, cleanupCause))
    throw cause
  }

  if (!updated) {
    await env.AVATARS.delete(key).catch((cause) => logCleanupFailure('rollback', key, cause))
    return json({ error: 'La foto ha cambiado en otro dispositivo. Vuelve a intentarlo.' }, 409)
  }

  if (previousKey) {
    locals.cfContext.waitUntil(
      env.AVATARS.delete(previousKey).catch((cause) => logCleanupFailure('replace', previousKey, cause)),
    )
  }

  return json({ avatarUrl: avatarUrl(user.id, key) })
}

/** Clear the database reference first; a failed R2 cleanup can only leave an orphan. */
export const DELETE: APIRoute = async ({ locals }) => {
  const user = locals.user!
  const previousKey = user.avatarKey
  if (!previousKey) {
    return new Response(null, { status: 204, headers: { 'cache-control': 'no-store' } })
  }

  const db = createDb(env.DB)
  const [updated] = await db
    .update(users)
    .set({ avatarKey: null })
    .where(and(eq(users.id, user.id), eq(users.avatarKey, previousKey)))
    .returning({ id: users.id })

  if (!updated) {
    return json({ error: 'La foto ha cambiado en otro dispositivo. Recarga los ajustes.' }, 409)
  }

  locals.cfContext.waitUntil(
    env.AVATARS.delete(previousKey).catch((cause) => logCleanupFailure('remove', previousKey, cause)),
  )
  return new Response(null, { status: 204, headers: { 'cache-control': 'no-store' } })
}

