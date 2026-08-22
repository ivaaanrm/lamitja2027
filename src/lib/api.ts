import type { ZodError } from 'zod'

/**
 * Response helpers shared by the API routes. `no-store` throughout: every endpoint here
 * returns one athlete's private data, and the service worker caches the app shell, not
 * the data behind it.
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
