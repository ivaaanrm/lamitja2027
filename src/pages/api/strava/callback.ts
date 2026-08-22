import type { APIRoute } from 'astro'
import { env } from 'cloudflare:workers'
import { createDb } from '@/lib/db/client'
import { exchangeCode, saveTokens } from '@/lib/strava'
import { syncBlock } from '@/lib/sync'

export const prerender = false

const back = (status: string) =>
  new Response(null, { status: 302, headers: { location: `/?strava=${status}` } })

export const GET: APIRoute = async ({ url, locals }) => {
  const code = url.searchParams.get('code')
  const state = url.searchParams.get('state')
  if (url.searchParams.get('error') || !code || !state) return back('error')

  // Single-use: consume the state before doing anything else.
  if (!(await env.CACHE.get(`oauth:${state}`))) return back('bad_state')
  await env.CACHE.delete(`oauth:${state}`)

  // Without activity:read_all the sync silently misses private runs.
  if (!(url.searchParams.get('scope') ?? '').includes('activity:read_all')) {
    return back('scope')
  }

  const db = createDb(env.DB)
  await saveTokens(db, await exchangeCode(code))

  // The block is one request; run it inline so the page is populated on return.
  locals.cfContext?.waitUntil(
    syncBlock(db).catch((error) => console.error('[callback] sync failed', error)),
  )

  return back('ok')
}
