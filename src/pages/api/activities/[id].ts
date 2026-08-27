import type { APIRoute } from 'astro'
import { env } from 'cloudflare:workers'
import { and, eq } from 'drizzle-orm'
import { json } from '@/lib/api'
import { createDb } from '@/lib/db/client'
import { activities } from '@/lib/db/schema'
import { DEFAULT_HR_MAX } from '@/lib/paces'
import { accessToken, fetchActivityDetail } from '@/lib/strava'
import { buildDetail } from '@/lib/streams'

export const prerender = false

/**
 * The trace behind one activity — pace, pulse, cadence and altitude folded into distance
 * bins, the per-km splits, the laps and the description.
 *
 * Read through to Strava on every open, never stored: three API calls for a run the
 * athlete is looking at right now is nothing against the read limit, and a table of
 * streams would be a second copy of Strava's record for the one screen that reads it.
 * The id has to be one that was synced for *this* athlete — the ownership check below is
 * what stops the endpoint from reading another athlete's activity off their own account.
 */
export const GET: APIRoute = async ({ params, locals }) => {
  const user = locals.user!
  const id = Number(params.id)
  if (!Number.isInteger(id)) return json({ error: 'Falta el id de la actividad' }, 400)

  const db = createDb(env.DB)
  const known = await db.query.activities.findFirst({
    where: and(eq(activities.id, id), eq(activities.userId, user.id)),
    columns: { id: true },
  })
  if (!known) return json({ error: 'No existe esa actividad' }, 404)

  const token = await accessToken(db, user.id)
  const fetched = await fetchActivityDetail(token, id)
  if (!fetched) return json({ error: 'Strava ya no tiene esa actividad' }, 404)

  // Zones are shares of this athlete's own max HR, never a textbook default once they have
  // set one on `/ajustes`.
  return json(buildDetail(fetched.streams, fetched.activity, user.hrMax ?? DEFAULT_HR_MAX))
}
