# La Mitja 2027

Training tracker for a sub-1:20 half marathon at La Mitja on **24 January 2027**.
Astro PWA on a single Cloudflare Worker, D1 for storage.

**Scope is deliberately narrow: one athlete, one 22-week block starting Mon 24 Aug 2026.**
That is ~150 activities in total. Nothing before the block is synced — the 2020–2026
history lives in `docs/data/*.csv`, where the analysis that needed it already happened.
Read that constraint before adding anything: it is why there is no outbox, no pagination,
no rate-limit budget, no tombstones and no materialised metrics.

Training design (phases, volumes, paces, knee protocol): `docs/03-training-plan-2027.md`.

## Commands

```bash
pnpm dev                  # astro dev (workerd via the Cloudflare vite plugin)
pnpm build                # → dist/client (assets) + dist/server (worker)
pnpm preview              # wrangler dev against the built output
pnpm deploy               # build + deploy
pnpm test                 # vitest
pnpm cf-typegen           # regenerate worker-configuration.d.ts after editing wrangler.jsonc
pnpm db:generate          # regenerate migrations from src/lib/db/schema.ts
pnpm db:migrate           # apply migrations to remote
pnpm db:migrate:local     # apply migrations locally
```

Trigger the nightly sync without waiting for the clock (against `pnpm preview`):

```bash
curl "http://localhost:8787/cdn-cgi/handler/scheduled?cron=0+3+*+*+*&format=json"
```

## Shape

**Three tables** (`src/lib/db/schema.ts`, the source of truth — never hand-edit
`migrations/`):

| Table | Holds |
|---|---|
| `activities` | Runs and rides inside the block. Strava units, one row per activity. |
| `plan_sessions` | The prescribed plan, one row per session, re-seedable by id. |
| `app_state` | Two values: the encrypted Strava refresh token and the last sync time. |

**Auth is one password, not Strava OAuth.** Strava OAuth is how the *server* obtains an
API token; making it the login would mean re-authorising on every device. `APP_PASSWORD`
is exchanged once for a signed, year-long cookie that works on desktop and iPhone alike.
Rotating `APP_PASSWORD` signs every device out. `src/middleware.ts` gates `/api/*` closed
by default, with an explicit public list.

**Sync is one function with no cursor.** `syncBlock()` fetches everything after
`BLOCK_START` in a single request and upserts it. The block is one page of results, so
re-fetching the whole window costs one API call and removes every class of cursor-drift
bug — a renamed or corrected activity self-heals. The webhook triggers it (ignoring the
event body entirely — any event just means "refresh"), and a nightly cron is the safety net.

## Platform gotchas — verified, do not re-derive

1. **Astro 7.2 + `@astrojs/cloudflare` 14.2.** Most guidance online still describes Astro 6
   / adapter 13.
2. **`Astro.locals.runtime` is gone.** Bindings come from
   `import { env } from 'cloudflare:workers'`; the execution context is `Astro.locals.cfContext`.
3. **A fully static build silently drops the Worker** — with no `prerender = false` route
   the adapter emits an assets-only config with no `main`, and the cron handler disappears
   with it. The `/api` routes are what keep it alive.
4. **The custom worker entrypoint is supported.** Adapter `dist/wrangler.js` resolves
   `main: config.main ?? "@astrojs/cloudflare/entrypoints/server"`, so the `main` in our
   `wrangler.jsonc` wins — that is how `fetch` and `scheduled` share one Worker.
5. **The handler export is named**: `import { handle } from '@astrojs/cloudflare/handler'`.
   There is no default export with a `.fetch` property.
6. **Deploy uses the generated config**: `wrangler deploy -c dist/server/wrangler.json`.
   A bare `wrangler deploy` resolves `assets.directory` wrongly.
7. **D1 allows at most 100 bound parameters per query** — far tighter than SQLite's 999.
   Batch inserts derive rows-per-statement from the column count (`src/lib/sync.ts`) so
   adding a column cannot silently push a statement over the limit.
8. **Strava's callback domain is app-wide**, set once at strava.com/settings/api. It must
   match the deployed host or `/oauth/authorize` 400s before the consent screen renders.
   Currently `lamitja2027.iromero-py.workers.dev`, so OAuth does not complete against localhost.
9. **Strava rotates the refresh token on every refresh.** `src/lib/strava.ts` persists the
   new one each time; dropping it strands the app on a dead credential.
10. **`activity:read_all` is mandatory** — without it private activities are invisible and
    volume totals are silently wrong. The callback rejects a grant that lacks it.
11. **TypeScript 7 removed `baseUrl`**; use `paths` with `./` prefixes. Vite 8 resolves
    tsconfig paths natively (`resolve.tsconfigPaths: true`) — no plugin.
12. **pnpm 11 gates build scripts** via `allowBuilds` in `pnpm-workspace.yaml`. Without it
    `workerd` never installs its binary. `pnpm approve-builds --all` writes the right shape.
13. **`wrangler d1 execute --file` against remote is flaky** (upload step fails on transient
    network errors). Retry, or use `--command`.

## Conventions

- **Units follow Strava**: metres, seconds, m/s. Paces (s/km) are derived at read time.
- **Cadence is stored as spm**, already doubled from Strava's rpm. 85 rpm ≈ 170 spm, and
  cadence is the primary marker in the knee protocol — halving it misreads the metric.
- **Dates are INTEGER epoch milliseconds**, stored as the athlete's local wall clock, so
  "which day was this run" does not depend on the viewing device.
- **Pure logic stays out of I/O modules.** `src/lib/activity.ts` and `src/lib/block.ts`
  import nothing from `cloudflare:workers` and are unit-tested in plain Node;
  `src/lib/sync.ts` and `src/lib/strava.ts` own the side effects.
- Pages are prerendered. Only `src/pages/api/**` sets `export const prerender = false`.
- **Secrets vs vars**: `STRAVA_CLIENT_SECRET`, `STRAVA_WEBHOOK_VERIFY`, `TOKEN_ENC_KEY` and
  `APP_PASSWORD` are secrets. The Strava client ID is public and lives in `wrangler.jsonc`.
