import type { AstroGlobal } from 'astro'
import type { APIContext } from 'astro'

export interface SessionData {
  athleteId: number
}

type Ctx = APIContext | AstroGlobal

/**
 * Astro Sessions are backed by the SESSION KV namespace (wired in astro.config.mjs).
 * Only on-demand routes have a session — prerendered pages are the public app shell and
 * deliberately carry no athlete data; the client fetches it from /api/sync instead.
 */
export async function setSession(ctx: Ctx, data: SessionData): Promise<void> {
  if (!ctx.session) throw new Error('Sessions unavailable on a prerendered route')
  await ctx.session.set('athleteId', data.athleteId)
}

export async function getAthleteId(ctx: Ctx): Promise<number | null> {
  if (!ctx.session) return null
  const athleteId = await ctx.session.get<number>('athleteId')
  return typeof athleteId === 'number' ? athleteId : null
}

export async function destroySession(ctx: Ctx): Promise<void> {
  ctx.session?.destroy()
}

/** 401s unauthenticated callers. Returns the athlete id when signed in. */
export async function requireAthleteId(ctx: Ctx): Promise<number> {
  const athleteId = await getAthleteId(ctx)
  if (athleteId === null) throw new UnauthorizedError()
  return athleteId
}

export class UnauthorizedError extends Error {
  constructor() {
    super('Not signed in')
    this.name = 'UnauthorizedError'
  }
}

export function jsonError(message: string, status: number): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  })
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  })
}
