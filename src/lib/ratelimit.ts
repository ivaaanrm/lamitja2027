import { env } from 'cloudflare:workers'

/**
 * A speed bump in front of the two endpoints that take a credential.
 *
 * The app is one password and one bearer token, and until now either could be guessed at
 * as fast as the network allowed. That was survivable while the address was known to one
 * person; it stops being survivable the moment the repository is public, because the URL
 * and the shape of the door are then both documented.
 *
 * Cloudflare's `ratelimit` binding rather than KV counters: it is built for this, it costs
 * no writes, and a KV counter cannot be incremented more than once a second per key, which
 * is slower than the thing it is meant to be counting. It is *not* available as a WAF rule
 * here — those are configured per zone, and a `workers.dev` subdomain is not a zone anyone
 * but Cloudflare owns.
 *
 * **What this is and is not.** The binding is per-location and eventually consistent, so
 * an attacker spread across enough Cloudflare colos gets a multiple of the limit below,
 * and a burst can overshoot it. It is a speed bump, deliberately: the actual defence is
 * the entropy of `APP_PASSWORD`, and nothing here excuses a short one. What it buys is
 * that an unattended script pointed at `/api/login` stops being free.
 *
 * **It fails open.** A missing binding — local `wrangler dev`, or a fork that dropped it
 * from `wrangler.jsonc` — means no limiting rather than no app. An app that will not let
 * its owner sign in because a rate limiter is unavailable has turned a hardening measure
 * into an outage, and the credential check behind it is still there either way.
 */

/**
 * The limiters declared in `wrangler.jsonc`, named by their bindings. `Env` types both as
 * `RateLimit`, so a limiter added to the config and not here — or removed from the config
 * and still named here — fails the build rather than the request.
 */
export type LimiterName = {
  [K in keyof Env]: Env[K] extends RateLimit ? K : never
}[keyof Env]

/**
 * Who is asking. `cf-connecting-ip` is the only identity an unauthenticated request has —
 * the credential is the thing in question, so it cannot also be the key.
 *
 * Cloudflare's own guidance is to prefer a stable account identifier over an IP, because
 * one IP can be a whole office behind NAT. That warning does not apply here and its
 * inverse does: this deployment has exactly one legitimate user, so a false positive costs
 * one person one minute, while keying anything else would mean keying on the credential
 * being guessed. The header is set by the edge and cannot be spoofed by the client.
 */
const callerKey = (request: Request): string =>
  request.headers.get('cf-connecting-ip') ?? 'unknown'

/**
 * `true` when the request may proceed.
 *
 * Called *before* the credential is checked, never after. Counting only the failures reads
 * like the kinder design and is worthless: if a correct guess skips the limiter, then
 * every guess is still checked and the guesser is throttled in nothing but the status code
 * they get back. The cost of checking first is that a legitimate sign-in also counts, and
 * at these limits a person never notices.
 */
export async function withinLimit(name: LimiterName, request: Request): Promise<boolean> {
  const limiter = env[name] as RateLimit | undefined
  if (typeof limiter?.limit !== 'function') return true

  try {
    const { success } = await limiter.limit({ key: `${name}:${callerKey(request)}` })
    return success
  } catch (error) {
    console.error(`[ratelimit] ${name} unavailable`, error)
    return true
  }
}
