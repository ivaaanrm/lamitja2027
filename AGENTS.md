# La Mitja 2027

Training tracker for a sub-1:20 half marathon at La Mitja on **24 January 2027**.
Astro PWA on a single Cloudflare Worker, D1 for storage.

**Scope is deliberately narrow: one athlete, one 23-week block starting Mon 17 Aug 2026.**
That is ~150 activities in total. Nothing before the block is synced — the 2020–2026
history lives in `docs/data/*.csv`, and the app reads the 2025-26 season straight out of
those files (`src/lib/baseline.ts`) rather than storing a second copy of a finished record.
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

**Four tables** (`src/lib/db/schema.ts`, the source of truth — never hand-edit
`migrations/`):

| Table | Holds |
|---|---|
| `activities` | Runs and rides inside the block. Strava units, one row per activity. |
| `plan_weeks` | One row per week of the block: phase, volume target, down-week flag. |
| `plan_sessions` | The prescribed plan, one row per session, each with its workout as structured steps. |
| `app_state` | Two values: the encrypted Strava refresh token and the last sync time. |

**The plan is written, not generated.** `src/lib/seed.ts` is the 23 weeks of
`docs/03-training-plan-2027.md` typed out, week by week — a deterministic function, not an
engine. `POST /api/plan/seed` writes it, keyed on ids derived from week and weekday, so
re-seeding is "reset to the plan" and overwrites anything edited by hand. Every column
that isn't structural is still nullable and still editable from `/plan`, because the phase
boundaries and volume targets in `docs/03` are expected to move as the knee and the Phase 0
gate report back.

**Only the easy runs are computed.** Quality sessions, races and race-pace long runs are
fixed prescriptions; the easy runs absorb whatever the week's volume target has left over
after them. When the ramp moves, the workouts stay put and the easy days flex. A week's
`target_volume_m` is then the sum of what its sessions actually prescribe rather than the
ramp figure they were sized from — a target no session adds up to is a number that quietly
stops meaning anything.

**A workout is data, not prose** (`src/lib/workout.ts`). A session carries a list of steps
— warm-up, `5 × 1 km @ vo2` with a `90 s jog` recovery, cool-down — so the repetitions can
be counted, the recovery jogs can be added to the week's volume, and the rep pace is
something the app knows rather than something the eye reads. `notes` is for coaching prose
only: terrain, cadence, what to abort on. Steps are JSON on the session rather than a
`plan_steps` table because a step has no identity of its own — it is never queried, sorted
or joined, only read back whole with the session that owns it. Distances and estimated
durations are derived from the steps, never stored twice; editing a session's numbers by
hand drops its steps rather than leaving a stale breakdown behind.

**Plan-to-actual matching happens on read, not on sync** (`src/lib/plan.ts`). A session is
done when it was ticked off by hand *or* when an activity on the same day matches it: same
sport family, and nearest to its target distance. Nothing is written back, so a corrected
distance or a session dragged to another day re-resolves on the next render, and completing
a run costs no database write. `plan_sessions.activity_id` pins a session to one activity
and always beats the heuristic — the escape hatch for the days it guesses wrong. Sessions
Strava will never report (strength, cross) are the ones that use `done_at`.

**A session's week is derived from `scheduled_on`, never stored.** Moving a session to
another day must not be able to leave a stale week index behind it. Likewise a week's
Monday is `BLOCK_START + i * WEEK_MS`, not a column.

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

**Four tabs, one dock.** `/` `/plan` `/progreso` `/registro`, listed once in
`src/lib/nav.ts` and rendered by `src/components/Dock.astro` — plain HTML fixed to the
bottom of the viewport, with `env(safe-area-inset-bottom)` under it so it clears the home
indicator. It ships no JavaScript: every page is prerendered, so which tab is lit is known
at build time. `src/layouts/App.astro` is the shell that pairs it with the page column and
reserves the bottom padding; `/login` uses `Base.astro` directly and has no dock.

**Last season is data, not memory** (`src/lib/baseline.ts`). `docs/data/*.csv` is imported
`?raw` and parsed into `Activity` rows, so the 2025-26 build can be compared against
without a table, a sync or a second copy to keep honest. The rows are shifted by
`RACE_DATE - PREV_RACE_DATE` — 371 days, exactly 53 weeks — which lands every one of them
on the same weekday *and* the same distance from race day. That is the only alignment that
answers "am I ahead of where I was": last season's build was 20 weeks against this one's
23, so week 12 is not the same place in the two and "eleven weeks out" always is. It leaves
block weeks 1–3 with no counterpart, and those read as absent rather than as zero.
`PRE_BLOCK` is the Jan–Aug 2026 injury period, never compared against — it exists only to
run in the 42-day average so the fitness curve does not open at zero on 17 August.

**Analytics are read-time and pure** (`src/lib/analytics.ts`). Fitness and fatigue are the
usual 42/7-day exponential averages over training load; load is Strava's Relative Effort
where the strap recorded one, and otherwise a least-squares fallback fitted to the 100 runs
in `docs/data` that carry one (±33%, so `estimatedShare` reports how much of a window
leaned on it). Best efforts come from whole runs rather than splits, because the app stores
summaries — and only from runs that were *efforts* (Z4+, or faster than steady), or the
10 km best would be won by whichever easy run happened to be ten kilometres long. Every
function takes `Activity[]` and a window, which is what lets both seasons run through
identical code.

**The charts are hand-rolled** (`src/components/charts.tsx`): an SVG polyline for the
trends and flexbox divs for the bars. A library is ~100 KB into a PWA that is otherwise a
few tens, it renders its own text at its own sizes, and none of these charts want a tooltip
— on a phone the number is on the card above the chart. Series colours are passed in as
Tailwind classes so a chart is styled like everything else on the page.

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
14. **`?raw` imports work, including from outside `src/`.** `docs/data/*.csv` is inlined at
    build time by Vite — in the Worker bundle, in the prerender pass and in vitest alike.
    `astro/client` pulls in `vite/client`, so the module is typed without a declaration.
15. **A `client:load` island is also rendered during prerender**, in a Worker, where
    `location` and `window` do not exist. Touching either in a component body fails the
    build rather than the page — read them inside an effect or an event handler.
16. **`pnpm preview` needs `--persist-to`.** Wrangler resolves local storage relative to the
    config file, and `preview` points at `dist/server/wrangler.json` — so without it the
    preview gets a *second, empty* D1 under `dist/server/.wrangler/`, and every query fails
    with a missing table while `pnpm db:migrate:local` looks like it worked. It also serves
    the assets it saw at startup: rebuild while it is running and every page 404s until it
    is restarted.

## Conventions

- **The app speaks Spanish (España); the codebase speaks English.** Every string a person
  reads is Spanish — labels, session titles, coaching notes, API error messages, the
  manifest, `<html lang="es">` — and every `Intl` formatter is built with `'es-ES'`.
  Identifiers, comments and commit messages stay English. The training vocabulary follows
  the club idiom the athlete already trains in: *rodaje*, *series*, *tirada larga*,
  *progresiones*, *fartlek*.
- **Numbers are written Spanish too.** `src/lib/format.ts` owns `decimal()`, and nothing
  renders a bare `toFixed(1)` — `12.4 km` on screen is as wrong as an English label.
- **Intensity is Z1–Z5, never a heart rate.** `src/lib/paces.ts` owns the five-zone model:
  `PACE_ZONE_NUMBER` maps each pace band onto a zone, and `hrZone()` maps an average
  heart rate onto one. The exact bpm is never rendered — it drifts with heat, sleep and
  the strap, and no decision in the plan is made on it. `HR_MAX` and the zone floors are
  calibrated against the two races in docs/01, not a textbook formula.
- **Units follow Strava**: metres, seconds, m/s. Paces (s/km) are derived at read time.
- **Cadence is stored as spm**, already doubled from Strava's rpm. 85 rpm ≈ 170 spm, and
  cadence is the primary marker in the knee protocol — halving it misreads the metric.
  It renders as `pasos/min`, never `ppm` — which in Spanish reads as heart rate.
- **Dates are INTEGER epoch milliseconds**, stored as the athlete's local wall clock, so
  "which day was this run" does not depend on the viewing device.
- **Pure logic stays out of I/O modules.** `src/lib/activity.ts`, `src/lib/block.ts`,
  `src/lib/plan.ts`, `src/lib/workout.ts`, `src/lib/paces.ts`, `src/lib/format.ts`,
  `src/lib/seed.ts`, `src/lib/metrics.ts`, `src/lib/analytics.ts` and `src/lib/baseline.ts`
  import nothing from `cloudflare:workers`,
  take `now` explicitly, and are unit-tested in plain Node; `src/lib/sync.ts` and
  `src/lib/strava.ts` own the side effects.
- **`plan.ts` and `workout.ts` ship to the browser, so they pull in neither drizzle nor
  zod.** They own `SESSION_TYPES` and `Step`, and `db/schema.ts` imports them, not the other
  way round; the zod mirror of `Step` lives in `plan-input.ts`, which only the Worker ever
  loads, and a type-level assignment there fails the build if the two drift apart.
- **Session colours are written out, never composed.** Tailwind resolves classes by scanning
  source, so the accent map in `src/components/ui/index.tsx` spells each class in full —
  `bg-${accent}-400` is a class that never ships.
- **The UI reads everything from `/api/data` in one request** and derives the rest on the
  client. The block is a few tens of KB, so every mutation just re-reads it — there is no
  optimistic copy of the plan that can disagree with the database.
- Pages are prerendered. Only `src/pages/api/**` sets `export const prerender = false`.
- **`public/favicon.svg` is the icon master**; every PNG in `public/` is rasterised from it
  (`qlmanage -t -s <px> -o . favicon.svg`, macOS built-in — there is no image dependency).
  Edit the SVG and re-render all of them, or they drift. The mark is the La Mitja course
  profile: the climb through 10 km, then the descent that steepens to the finish.
- **Nothing in the repo is unreferenced.** Every asset is linked from `src/layouts/Base.astro`
  or `public/manifest.webmanifest`, every module is reachable from a page, the Worker or a
  test, and every `wrangler.jsonc` var is read by code. Keep it that way.
- **Secrets vs vars**: `STRAVA_CLIENT_SECRET`, `STRAVA_WEBHOOK_VERIFY`, `TOKEN_ENC_KEY` and
  `APP_PASSWORD` are secrets. The Strava client ID is public and lives in `wrangler.jsonc`.
