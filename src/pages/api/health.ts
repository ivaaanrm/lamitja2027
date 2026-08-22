import type { APIRoute } from 'astro'
import { env } from 'cloudflare:workers'

// On-demand. This is also what makes the adapter emit a Worker bundle at all —
// a fully static build has no `main`, and the cron `scheduled` handler would be
// silently dropped along with it.
export const prerender = false

export const GET: APIRoute = async () => {
  const checks: Record<string, string> = {}

  try {
    const row = await env.DB.prepare('select 1 as ok').first<{ ok: number }>()
    checks.d1 = row?.ok === 1 ? 'ok' : 'unexpected response'
  } catch (error) {
    checks.d1 = `error: ${error instanceof Error ? error.message : String(error)}`
  }

  try {
    await env.CACHE.get('__healthcheck__')
    checks.kv = 'ok'
  } catch (error) {
    checks.kv = `error: ${error instanceof Error ? error.message : String(error)}`
  }

  const healthy = Object.values(checks).every((v) => v === 'ok')

  return new Response(
    JSON.stringify({ status: healthy ? 'ok' : 'degraded', race: env.RACE_DATE, checks }, null, 2),
    {
      status: healthy ? 200 : 503,
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    },
  )
}
