import type { ZodError } from 'zod'

/**
 * Response helpers shared by the API routes. `no-store` throughout: every endpoint here
 * returns one athlete's private data, so no shared cache — no CDN, no proxy, no browser
 * HTTP cache — may keep a copy of it.
 *
 * The one deliberate exception is not a cache in that sense at all. `public/sw.js` keeps
 * the last `/api/data` payload in Cache Storage, which is a *private* store on the
 * athlete's own device that only this origin's own code can read — the same footing as
 * the session cookie, and the reason the app can still show the block at a trailhead with
 * no signal. It is written by an explicit `cache.put`, which is why `no-store` does not
 * stop it, it is dropped the moment `/api/data` answers 401, and a copy served from it
 * arrives carrying `x-lm-stale` so the app says on screen that it is showing one.
 */
export const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  })

/** 400 with field-level detail, which is what the plan editor renders next to the input. */
export const invalid = (error: ZodError) =>
  json(
    {
      error: 'Invalid input',
      issues: error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      })),
    },
    400,
  )

/** `null` for a body that is not JSON at all, so validation reports it rather than throwing. */
export const readJson = (request: Request): Promise<unknown> => request.json().catch(() => null)
