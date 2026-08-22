import type { APIRoute } from 'astro'
import { env } from 'cloudflare:workers'
import { json } from '@/lib/api'
import { createDb } from '@/lib/db/client'
import { syncBlock } from '@/lib/sync'

export const prerender = false

/** Manual "sync now". The nightly cron and the webhook cover the rest. */
export const POST: APIRoute = async () => {
  try {
    return json(await syncBlock(createDb(env.DB)))
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : 'Fallo al sincronizar' }, 502)
  }
}
