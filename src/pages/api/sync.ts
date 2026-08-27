import type { APIRoute } from 'astro'
import { env } from 'cloudflare:workers'
import { json } from '@/lib/api'
import { createDb } from '@/lib/db/client'
import { syncUser } from '@/lib/sync'

export const prerender = false

/** Manual "sync now" for the signed-in athlete. The nightly cron and the webhook cover the rest. */
export const POST: APIRoute = async ({ locals }) => {
  const user = locals.user!

  try {
    const result = await syncUser(createDb(env.DB), user.id)
    // Only reachable before `/bienvenida` sets a block — the dock's own prefetch does not
    // run this without one, but a stray call must not fetch every activity ever recorded.
    if (!result) return json({ error: 'Primero completa la configuración del bloque' }, 400)
    return json(result)
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : 'Fallo al sincronizar' }, 502)
  }
}
