# La Mitja 2027

Training tracker for a sub-1:20 half marathon at La Mitja on **24 January 2027**, rebuilt from
[PaceUp](https://github.com/ivaaanrm/PaceUp). Astro PWA on a single Cloudflare Worker, D1 as the
system of record, local-first IndexedDB mirror on the client.

Full architecture and phase plan: `~/.claude/plans/i-want-to-create-rippling-grove.md`.

## Commands

```bash
pnpm dev                  # astro dev (workerd via the Cloudflare vite plugin)
pnpm db:generate          # regenerate migrations from src/lib/db/schema.ts
pnpm build                # astro build → dist/client (assets) + dist/server (worker)
pnpm preview              # wrangler dev against the built output
pnpm deploy               # build + deploy
pnpm cf-typegen           # regenerate worker-configuration.d.ts after editing wrangler.jsonc
pnpm db:migrate:local     # apply D1 migrations locally
pnpm db:migrate           # apply D1 migrations to remote
pnpm test                 # vitest
```

Trigger a cron branch without waiting for the clock (against `pnpm preview`):

```bash
curl "http://localhost:8787/cdn-cgi/handler/scheduled?cron=0+3+*+*+*&format=json"
```

## Platform gotchas — verified, do not re-derive

These cost real time to establish. They are current as of Aug 2026.

1. **Astro 7.2 + `@astrojs/cloudflare` 14.2.** Much online guidance (and the Cloudflare docs) still
   describes Astro 6 / adapter 13. Adapter 14 peers `astro ^7.2` and `wrangler ^4.83`.

2. **`Astro.locals.runtime` is gone** (removed in adapter 13). Bindings come from
   `import { env } from 'cloudflare:workers'`. Execution context is `Astro.locals.cfContext`.

3. **A fully static build silently drops the Worker.** With no `prerender = false` route anywhere,
   the adapter emits an assets-only config with no `main` — and the cron `scheduled` handler
   disappears with it. `src/pages/api/health.ts` is what keeps the Worker alive; do not delete it
   without another on-demand route in place.

4. **The custom worker entrypoint is supported**, despite thin documentation. Adapter
   `dist/wrangler.js` resolves `main: config.main ?? "@astrojs/cloudflare/entrypoints/server"`, so
   the `main` in our `wrangler.jsonc` wins. That is how `fetch` (Astro) and `scheduled` (cron) share
   one Worker — see `src/worker.ts`.

5. **The handler export is named, not default.** `import { handle } from '@astrojs/cloudflare/handler'`
   — `handle(request, env, ctx)`. There is no default export with a `.fetch` property.

6. **Deploy uses the generated config, not the root one.** The build writes
   `dist/server/wrangler.json` with `main` and the correct relative `assets.directory` (`../client`).
   Deploy with `-c dist/server/wrangler.json`; a bare `wrangler deploy` resolves assets wrongly.

7. **`@vite-pwa/astro` does not support Astro 6+** (peers `astro ^1–^5`). Use `workbox-build`
   directly from a small `astro:build:done` integration instead — `vite-plugin-pwa`'s own hooks run
   on the client bundle, before Astro has emitted the HTML, so the precache manifest would miss pages.

8. **Strava's OAuth callback domain is app-wide, not per-URL.** It is set once at
   strava.com/settings/api and must match the deployed host, or `/oauth/authorize` returns
   `400 Bad Request — redirect_uri invalid` before the consent screen ever renders.

9. **Strava rotates the refresh token on every refresh.** Persisting only the new access
   token strands the athlete on a dead credential. `src/lib/strava/tokens.ts` writes both.

10. **`activity:read_all` is mandatory.** Without it Strava returns only public activities
   and the backfill silently comes back partial — every volume metric would be quietly wrong.
   The callback rejects a grant that lacks it rather than accepting a broken history.

11. **TypeScript 7 removed `baseUrl`.** Use `paths` with explicit `./` prefixes. Vite 8 also
   resolves tsconfig paths natively — `resolve.tsconfigPaths: true`, no plugin needed.

12. **pnpm 11 gates build scripts** via `allowBuilds` in `pnpm-workspace.yaml` (not
   `onlyBuiltDependencies` in `package.json`). Without it `workerd` never installs its binary.
   `pnpm approve-builds --all` writes the right shape.

## Conventions

- **Units follow Strava**: metres, seconds, m/s. Paces (s/km) are derived at read time, never stored.
- **Dates are INTEGER epoch milliseconds** in D1 — indexable, no string parsing.
- **`updated_at` on every mirrored table** drives the delta-sync cursor. Sync uses `>=` and relies on
  idempotent upserts, so an over-fetch at the boundary is safe and nothing is ever missed.
- **`src/lib/training/` is pure** — no I/O, no bindings, no dates from `Date.now()` passed implicitly.
  Every function takes `now` explicitly so tests are deterministic. This is the layer that must stay
  reproducible; the LLM never generates the plan, it only comments on it.
- Pages are prerendered by default. Only `src/pages/api/**` sets `export const prerender = false`.
- **The D1 schema lives in `src/lib/db/schema.ts`** (Drizzle) and is the single source of
  truth. Never hand-edit SQL in `migrations/` — change the schema and run `pnpm db:generate`.
- **Secrets vs vars**: only `STRAVA_CLIENT_SECRET`, `STRAVA_WEBHOOK_VERIFY` and
  `TOKEN_ENC_KEY` are secrets. The client ID and athlete allowlist are public values and
  live in `wrangler.jsonc` so they are version-controlled and reviewable.

## Strava integration

- **D1 allows at most 100 bound parameters per query.** Batch inserts must derive their
  rows-per-statement from the column count (`src/lib/sync/activities.ts`), not a fixed
  number — activities have 26 columns, so a 20-row insert sends 520 parameters and fails
  outright. `test/unit/d1-limits.test.ts` guards this when columns are added.
- **`drainJobs` works in rounds.** A backfill page enqueues the *next* page, so a
  single-round drain would advance history by only one page per cron tick.
- **Laps are only fetched for activities arriving via webhook**, not for backfilled ones —
  one API call per activity would blow the read budget. Backfilling laps for historical
  workouts is a deliberate later job.

- **Webhook subscription 367706** → `/api/strava/webhook`. One subscription per Strava app;
  list or replace it via `https://www.strava.com/api/v3/push_subscriptions`.
- The webhook returns 200 for anything well-formed and does the work in `waitUntil`. A
  non-2xx makes Strava retry and eventually disable the subscription — dropping one event
  is better than losing the hook.
- **The outbox (`sync_jobs`) is the reliability mechanism**, not the webhook. Every event
  becomes a row; the quarter-hourly cron drains it with backoff, and the nightly
  reconciliation catches whatever the webhook never delivered.
- Backfill walks history **one page per cron tick** using `before`, and re-enqueues itself
  until `backfillComplete`. Never loop pages inside one request — that is what burns the
  100-per-15-min read budget.
