import type { APIRoute } from 'astro'
import { env } from 'cloudflare:workers'
import { eq } from 'drizzle-orm'
import { invalid, json, readJson } from '@/lib/api'
import { consentInput } from '@/lib/auth-input'
import { createDb } from '@/lib/db/client'
import { blocks } from '@/lib/db/schema'
import { d1GrantStore } from '@/lib/oauth/grants'
import { approveConsent, denyConsent, openConsent } from '@/lib/oauth/server'

export const prerender = false

/** One sentence for a seal that is stale, forged or mangled — the fix is the same for all three. */
const EXPIRED = 'La solicitud ha caducado o no es válida. Vuelve a conectar desde la aplicación.'
const NO_BLOCK = 'Configura tu bloque antes de conectar una aplicación: sin él no hay semanas que leer.'

/**
 * The half of the authorization flow that needs to know who the athlete is.
 *
 * `/oauth/authorize` validated the client's request without a session and sealed it into
 * the URL of `/autorizar`; this route, behind the cookie gate like every other `/api` path,
 * is where that request meets a signed-in athlete. A `401` here is what sends the consent
 * screen to `/login` first, and back again afterwards.
 *
 * `GET` describes what is being asked, for the screen to render; `POST` records the
 * answer and returns where to send the browser — the client's redirect URI, carrying a
 * code or an `access_denied`. The browser navigates there itself: a `302` in reply to a
 * `fetch` would be followed by the fetch, not by the page.
 *
 * Cross-site, this cannot be driven: the cookie is `SameSite=Lax`, so another site's POST
 * arrives signed out, and the body has to be JSON, which no form can send and no other
 * origin can `fetch` here without a CORS preflight this route never answers.
 */
export const GET: APIRoute = async ({ request, locals }) => {
  const user = locals.user!
  const sealed = new URL(request.url).searchParams.get('req') ?? ''
  const pending = await openConsent(sealed, env.SESSION_SECRET, Date.now())
  if (!pending) return json({ error: EXPIRED }, 400)

  const block = await createDb(env.DB).query.blocks.findFirst({ where: eq(blocks.userId, user.id) })
  return json({
    client: pending.identity,
    user: { displayName: user.displayName, email: user.email },
    hasBlock: block !== undefined,
  })
}

export const POST: APIRoute = async ({ request, locals }) => {
  const user = locals.user!
  if (!(request.headers.get('content-type') ?? '').includes('application/json')) {
    return json({ error: 'Se esperaba JSON' }, 415)
  }
  const parsed = consentInput.safeParse(await readJson(request))
  if (!parsed.success) return invalid(parsed.error)

  const now = Date.now()
  const pending = await openConsent(parsed.data.req, env.SESSION_SECRET, now)
  if (!pending) return json({ error: EXPIRED }, 400)

  const origin = new URL(request.url).origin
  if (!parsed.data.approve) return json({ redirect: denyConsent(pending, origin) })

  const db = createDb(env.DB)
  // Every tool counts weeks from a block, and the MCP endpoint answers 401 to an athlete
  // without one — which a connected client would read as "sign in again", forever.
  const block = await db.query.blocks.findFirst({ where: eq(blocks.userId, user.id) })
  if (!block) return json({ error: NO_BLOCK }, 409)

  return json({ redirect: await approveConsent(pending, user.id, d1GrantStore(db), origin, now) })
}
