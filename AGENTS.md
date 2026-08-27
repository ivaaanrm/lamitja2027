# La Mitja 2027

Training tracker for a sub-1:20 half marathon at La Mitja on **24 January 2027**.
Astro PWA on a single Cloudflare Worker, D1 for storage.

**Scope is deliberately narrow: one athlete, one 23-week block starting Mon 17 Aug 2026.**
That is ~150 activities in total. Nothing before the block is synced — the 2020–2026
history lives in `docs/data/*.csv`, and the app reads the 2025-26 season straight out of
those files (`src/lib/baseline.ts`) rather than storing a second copy of a finished record.
Read that constraint before adding anything: it is why there is no outbox, no pagination,
no rate-limit budget, no tombstones and no materialised metrics.

Narrow is not the same as hard-coded. The repository is open source (MIT), and *which*
block it tracks — the race, its date and distance, the Monday it opens on, the goal, the
athlete's `HR_MAX`, and every name the app calls itself by — is eleven `PUBLIC_*` values
with this block as their defaults; see
**The block's edges are configuration** below — eleven `PUBLIC_*` values covering both the
block and every name the app calls itself by. Everything a forker follows once lives in
`README.md` and `docs/setup.md`, and belongs there rather than here: this file is for
whoever is changing the code. The project is *StrideAI*; *La Mitja 2027* is the reference
instance it ships configured as.

Training design (phases, volumes, paces, knee protocol): `docs/03-training-plan-2027.md`.

## Commands

```bash
pnpm dev                  # astro dev (workerd via the Cloudflare vite plugin)
pnpm build                # → dist/client (assets) + dist/server (worker)
pnpm preview              # wrangler dev against the built output
pnpm deploy               # build + deploy
pnpm test                 # vitest
pnpm typecheck            # astro check — needs @astrojs/check, which is not a dependency
pnpm typecheck:ci         # astro sync && tsc --noEmit — the .ts/.tsx half, no extra install
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

**The block's edges are configuration; everything else about it is code**
(`src/lib/config.ts`). Eleven values are read from `import.meta.env.PUBLIC_*` with this
repository's own block as the defaults, so pointing the whole app at another race is a
`.env` rather than an edit to arithmetic. Seven are the block itself — the race's name,
date and distance, the Monday it opens on, the goal time, `HR_MAX`, and last season's
race. Four are *identity*: `APP_NAME`, `APP_SHORT_NAME`, `APP_DESCRIPTION`, `GOAL_LABEL`.

Identity is separate from `RACE_NAME` because they are different nouns — the event is
*La Mitja de Granollers* and the app is *La Mitja 2027*, one printed on a bib and the
other on a home screen — and a fork that could only override the race would end up with a
tab reading `Plan · La Mitja 2027` above a plan for Berlin. Between them the four reach
every user-visible name in one hop: all eight `<title>`s, `Boot.astro`'s wordmark,
`/login`'s eyebrow and hero, `404`, the meta description, the Open Graph card, and the
manifest. `/login`'s hero is `formatClock(GOAL_TIME_S)` and its eyebrow is
`APP_SHORT_NAME` with `RACE_DATE` formatted, so the app's first impression is the last
place a fork is greeted by somebody else's race.

Two files stay outside that reach and both are deliberate. `public/sw.js` is copied
byte-for-byte out of `public/`, so it never sees a build-time value — its offline page is
*nameless* rather than wrong, which is why its `<title>` is just `Sin conexión`. And
`manifest.webmanifest` moved the other way: it is now `src/pages/manifest.webmanifest.ts`,
a prerendered endpoint, precisely because a static JSON file could not read the name — and
the home screen is the surface where a wrong name is most visible and hardest to notice,
since you only see it after you install. With no
`.env` at all every number, date and pace is byte-identical to what it was before any of
this was configurable, which is what `DEFAULTS` and `test/unit/config.test.ts` exist to
pin.

`import.meta.env` and not the two alternatives, deliberately. `cloudflare:workers` env is
a *runtime* binding: reading it here would drag `block.ts`, `paces.ts`, `seed.ts`,
`analytics.ts` and the rest of the pure half into needing a Worker alive around them, and
would turn `TOTAL_WEEKS` from a constant into a call every caller has to thread a binding
through. `astro:env` is build-time but resolves through Astro's module graph, and vitest
imports these modules directly with no Astro around them. `import.meta.env` is the only
one of the three present in all four places these numbers are read — client bundle,
Worker, prerender pass, unit tests — and Vite substitutes it at build, so the training
maths stays a set of constants. The cost is worth saying out loud rather than discovering:
these values are *compiled in*, so changing one is a rebuild and a redeploy, not a
restart. That is the honest shape for something that differs per **fork** rather than per
environment — a race date does not change between staging and production.

Three things now follow from those values instead of sitting beside them. `TOTAL_WEEKS` is
`ceil((RACE_DATE − BLOCK_START) / WEEK_MS)`. The five phases are *shares* of it
(`PHASE_SHAPE` + `resolvePhases` in `seed.ts`, rounding the cumulative share and clamping
so every phase keeps at least one week), so a 19-week fork still gets all five —
*reconstrucción* through *puesta a punto* — and at 23 they reproduce 0–6 / 7–12 / 13–17 /
18–20 / 21–22 exactly. And the six pace bands are **ratios of goal pace** (`BAND_RATIOS`,
six decimals, each line carrying the pace it was derived from) rather than a table of
seconds — a ratio and not an offset because ability scales and offsets do not: goal pace
plus 73 s/km is a sane easy run for a 3:47/km runner and asks a 5:30/km one to jog at
6:43. At the default goal every ratio rounds back to exactly the second docs/03 §4 wrote
down.

Every value is validated at module load, so a typo fails the *build* rather than quietly
seeding twenty-three weeks against the wrong year: blank counts as absent, a date has to
be a real calendar day, the block has to open on a Monday and run at least four weeks, and
last season's race has to precede this one. Those messages are English — they are read in
a build log by whoever just edited `.env`, not by the athlete. One gap to know about:
`vitest.config.ts` sets no `envPrefix`, and Vitest's default is `VITE_`, so a fork's
`.env` reaches the Astro build but *not* the unit tests, which run against the defaults.
Adding `envPrefix: 'PUBLIC_'` closes it, and correctly breaks the two places that assert
the example block outright: `seed.test.ts`'s `TOTAL_WEEKS === 23` and the race session's
title, and `config.test.ts`'s *the block the app actually runs on* — which pins the live
`BLOCK_START`, `RACE_DATE`, `GOAL_TIME_S`, `HR_MAX` and the six-band `PACES` table, and
is the only test that proves `config.ts` is wired to its consumers rather than merely
parsing correctly. Those assertions are about the example block and belong with it.

**The plan is written, not generated.** `src/lib/seed.ts` is the 23 weeks of
`docs/03-training-plan-2027.md` typed out, week by week — a deterministic function, not an
engine. `POST /api/plan/seed` writes it, keyed on ids derived from week and weekday, so
re-seeding is "reset to the plan" and overwrites anything edited by hand. Every column
that isn't structural is still nullable and still editable from `/plan`, because the phase
boundaries and volume targets in `docs/03` are expected to move as the knee and the Phase 0
gate report back.

Which makes `seed.ts` the one file that is an *example* rather than machinery: it is this
athlete's block, in Spanish, and a fork either rewrites those weeks or writes its own plan
through the MCP server and never seeds at all. `slotsFor` throws by name when
`WEEKS.length !== TOTAL_WEEKS`, because the silent version of that mismatch is a 19-week
fork getting this block's first 19 weeks — no taper, no race.

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

One password behind a public URL is one password behind a *known* URL, so the two
endpoints that take a credential sit behind Cloudflare's `ratelimit` binding
(`src/lib/ratelimit.ts`, declared in `wrangler.jsonc`): `/api/login` at 8 a minute, and
`/api/mcp` at 60 — higher because a legitimate caller there is an agent writing a whole
block in a burst, not a person signing in. Three things about it are load-bearing.

*It is consulted before the credential, never after.* Counting only failures reads like
the kinder design and protects nothing: if a correct guess skips the limiter, every guess
is still checked and the only thing throttled is the status code the guesser gets back.
The cost is that a legitimate sign-in also counts, which at eight a minute nobody meets.

*It fails open.* A missing binding — local `wrangler dev`, or a fork that dropped it —
means no limiting rather than no app. An app that will not let its owner in because a
rate limiter is unavailable has turned a hardening measure into an outage.

*It is a speed bump, not a lock.* The binding is per-Cloudflare-location and eventually
consistent, so a spread-out attacker gets a multiple of those numbers. The actual defence
is the entropy of `APP_PASSWORD`. And note a WAF rate-limiting rule is **not** an option
here: those are configured per zone, and `workers.dev` is not a zone you own.

**The plan is also an MCP server** (`src/lib/mcp/`, `POST /api/mcp`). Typing twenty-three
weeks of sessions into a form is the one thing this app is bad at and the one thing an
agent is good at, so the same data the UI reads is offered as eleven tools: five reads —
the block brief, the weeks, the sessions, the activities, the derived summary — and six
writes, of which `create_sessions` exists so that "write me a 16-week plan" is one round
trip rather than ninety.

**Bearer, not cookie.** An MCP client has no cookie jar and no login form to post to, so
it presents `Authorization: Bearer <APP_PASSWORD>` — the same single password, compared
with `timingSafeEqual` before the JSON-RPC body is so much as parsed, and answered `500`
rather than let anyone in if the secret is unset. A second credential just for this
endpoint would be a second thing to rotate and a second thing to leak, and the endpoint
reaches exactly the data the password already unlocks. `/api/mcp` therefore sits in
`SELF_AUTHENTICATED_PATHS` in the middleware — its **own named set**, not another line in
`PUBLIC_PATHS`, because the difference between "checks its own auth" and "has no check at
all" is invisible at a glance and the cost of confusing them is the whole training log.

**The transport is hand-rolled and stateless**, for the reason the charts are: an SDK is a
dependency and a build surface for what is, here, one `POST` handler. Streamable HTTP,
JSON only — no SSE (every tool is a millisecond-scale D1 call, and a held connection bills
a Worker invocation for as long as the client keeps the socket), no sessions (nothing
survives between two calls that an id could name), no `GET` stream (`GET` and `DELETE`
answer `405`, which is how a client built against an older revision is told to stop
trying). The route exports `ALL` rather than `POST` precisely so those two reach the
transport and get a real `405` instead of Astro's 404, which reads as "wrong URL" and
sends a forker hunting for a typo. Two protocol eras are served at once because a forker's
client is whichever one their SDK shipped with, and a request carrying no version anywhere
is served leniently as legacy — that is what a bare `curl` looks like, and pointing one at
a server you just deployed is the first thing anybody does.

`protocol.ts` knows the wire and nothing about training; `tools.ts` takes its `Database`
and its secret as arguments, so both are testable in plain Node with a fabricated
`Request`, no D1 and no bindings, and `src/pages/api/mcp.ts` is the only file that knows
where `env.DB` and `env.APP_PASSWORD` come from.

**The tools reuse `plan-input.ts` rather than validating twice.** The MCP layer rewrites
types at the boundary — ISO dates to UTC-midnight ms, `mm:ss` paces to s/km, a step's
blanks filled in so an agent can write `{kind, distanceM, zone}` — and then hands the
result to the very same zod schemas the HTTP routes use. A second validator would be a
second definition of what a session is, and the two would drift on the first column added.
Likewise the brief is a *view* of `config.ts`, `block.ts` and `paces.ts`, never a second
copy: a test asserts that, so an MCP surface that starts telling agents different numbers
from the ones the app runs on fails the build.

**The tool descriptions are English while everything a person reads is Spanish**, and that
is not an oversight. The reader of a tool description is the agent; the reader of a
session's `title` and `notes` is the athlete, and the server's instructions say so
explicitly, in English, telling the agent to write those in Spanish. Two deliberate
divergences from the HTTP surface are commented in place because they look like drift:
`create_session`/`create_sessions` accept a client-chosen `id` and upsert on it (a stale
browser tab must not overwrite a session it never saw — an agent authoring a plan is the
opposite case, and without stable ids the same request run twice leaves two of every
session), and `seed_plan` duplicates ~25 lines of the seed route's chunking rather than
import a module that pulls `env` from `cloudflare:workers` at load.

**Sync is one function with no cursor.** `syncBlock()` fetches everything after
`BLOCK_START` in a single request and upserts it. The block is one page of results, so
re-fetching the whole window costs one API call and removes every class of cursor-drift
bug — a renamed or corrected activity self-heals. The webhook triggers it (ignoring the
event body entirely — any event just means "refresh"), and a nightly cron is the safety net.

**Four tabs, one dock.** `/` `/plan` `/progreso` `/registro`, listed once in
`src/lib/nav.ts` and rendered by `src/components/Dock.astro` — plain HTML fixed to the
bottom of the viewport, with `env(safe-area-inset-bottom)` under it so it clears the home
indicator. It has no JavaScript of its own: every page is prerendered, so which tab is lit is
known at build time. Tabs still switch without a document load — `Base.astro` mounts Astro's
`<ClientRouter />`, the dock is `transition:animate="none"` (swapped in place, never faded or
slid with the content — and never `transition:persist`, which would keep the old highlight
lit), the page column carries **no** `transition:name` at all so it rides the root snapshot,
which cross-fades on the app's own tokens in `global.css`, the four shells are prefetched on
load, and `useBlock` keeps the last `/api/data` payload in module scope so the next tab
paints with data and revalidates behind it when it has gone stale. `src/layouts/App.astro`
is the shell that pairs it with the page column and reserves the bottom padding; `/login`
uses `Base.astro` directly and has no dock.

Those four links are also the only ones in the app that carry `data-astro-prefetch="viewport"`,
and the config default is `tap` rather than viewport because of what the two detail screens
are. `/actividad` and `/sesion` are one prerendered document each, addressed by a query
string the server never reads — and Astro dedupes prefetches by *full URL*, so a viewport
default queued one download of the same `/actividad` shell per row scrolled past in
`/registro`, and again for `/sesion` on every week opened in `/plan`. `tap` fires on
`touchstart`, which buys the ~100ms before the tap completes for exactly the URL being
opened; `hover` would prefetch nothing at all on a phone.

Naming the page column is the one change to resist here. A `view-transition-name` lifts an
element into its own `::view-transition-group`, and a group animates the element's *box* —
so with a name on `<main>` every tab tap animated the full-document-height texture from
wherever the finger had left the scroll position (the router resets it to the top inside the
transition callback) to the top of the next screen, interpolating a height between a
one-screen `/` and a several-thousand-pixel `/registro` on the way. On a phone that reads as
the whole page lurching. Unnamed, the capture is the viewport and the only thing animating is
opacity. Name an element here only when you actually want its box to travel — which is what
`dock-active` is, and it is a 60×48 pill.

**The launch screen covers the cold start, and only the cold start**
(`src/components/Boot.astro` + `src/lib/boot.ts`). A prerendered shell paints instantly and
then sits there empty: skeletons are the right answer for one late card and the wrong one
for a whole viewport of them, which is what tapping the home-screen icon used to show. So
`App.astro` renders an overlay — `/login`'s tile and mark, the mark drawing itself on
`chart-draw`, an indeterminate mint rail under it — server-side, in the first paint, because
an overlay a script has to *insert* arrives after the empty screen it was meant to hide.
Three rules keep it honest: `useBlock` clears it when the first `/api/data` settles, success
*or* failure (an error card with a retry on it is a screen to act on, not one to keep
hiding); `boot.ts` holds it for a 480ms floor measured from the page opening, so an edge-fast
launch does not flash a half-drawn mark; and an inline dead-man switch drops it at 2.6s
whatever happened, with `<noscript>` removing it outright. The one path that does *not*
dismiss it is the 401 redirect to `/login` — the document is already leaving, and uncovering
it first would flash a screenful of skeletons on the way out. It carries
`transition:persist="boot"` because `ClientRouter` swaps the whole body and the incoming
page's copy would otherwise flash on every tab tap; persist can only keep a node that is
still there, so it is left hidden rather than removed (`visibility`, on a delayed step after
the fade, so it stops swallowing taps).

**`/404` is `/login`'s sibling, not a tab** (`src/pages/404.astro`). It wears `Base`, so it
has no dock: the lit tab is baked in at build time and a 404 belongs to none of the four, so
the bar would sit there with nothing highlighted on the one screen whose message is that you
are nowhere. `404` takes the hero-number slot the goal time takes on `/login`, in `label`
rather than red — a mistyped URL is not a failure of the training block — and there is one
way out rather than a menu. It is prerendered like everything else; Astro serves it through
the adapter's `prerenderedErrorPageFetch`, so an unmatched path comes back as a real 404
status with this HTML in it instead of the asset handler's bare "Not Found".

**The app works without a connection, and says so when it is** (`public/sw.js`,
`src/lib/pwa.ts`, `src/lib/net.ts`, `src/components/OfflineNotice.astro`). This is a plan
read at a trailhead and in a car park, so a launch with no signal may not end on the
browser's error page inside a window with no address bar. The service worker is
hand-rolled for the same reason the charts are: Workbox is a build step and a dependency
for four caching rules.

*Network-first for anything that can change, cache-first for anything that cannot.* The
shells and `/api/data` go to the network and fall back to the cache, so a deploy is picked
up on the next load and a fresh sync is never hidden behind a stale copy; `/_astro/*` and
the precached fonts go the other way, because a content hash *is* a version. Nothing is
stale-while-revalidate — that would hand the phone yesterday's plan while today's was
still in flight, on an app whose whole content is "what am I doing today".

Four caches, and the split is the design. `lm-core` is precached at install: fonts, mark,
manifest — stable URLs, so **bump `VERSION` when one of them is edited**. `lm-pages` holds
the shells keyed by *pathname with the query dropped*, because `/actividad?id=1` and
`?id=2` are one prerendered document and per-URL keys would store it once per run in the
log. `lm-assets` is deliberately **not** versioned and is LRU-trimmed to 60 entries: a
hashed filename cannot go stale, only become surplus, and purging it on an update would
throw away a good copy of a file that is still current. `lm-data` holds one entry.

A tab tap in this app is not a navigation, and the worker has to know that: `ClientRouter`
asks for the next shell with a plain `fetch()` carrying no navigate mode, no document
destination and no `Accept: text/html`, and a prefetch link carries none of them either. So
`isDocument` ends on "same-origin GET, not `/api/`, no file extension" — without that last
line every tab switch fell through to the network and an offline tap tore the whole app
down and rebuilt it through the full-load fallback.

Shells are cached as they are visited rather than precached, which is what makes this
need no build step: a deploy can never leave a stale shell pointing at a hashed chunk that
no longer exists. The payload cache holds private training data in an origin-scoped store
on the athlete's own phone — the same footing as the session cookie — and is dropped the
moment `/api/data` answers 401, which is how rotating `APP_PASSWORD` reaches it. A payload
served from it carries `x-lm-stale`, `useBlock` reads that, and `OfflineNotice` says on
screen that the numbers are from the last sync rather than from now: "42 km this week" and
"42 km the last time this phone had signal" are the same pixels and different facts. The
flag lives on `<html>` rather than in React state because two things know the answer and
neither is a component — the browser's `online`/`offline` events and that header — and
because `ClientRouter` swaps the body and leaves the root alone. Registration is
production-only and `test/unit/sw.test.ts` runs the shipped file against stub caches.

**An installed app is resumed, not reopened** (`src/components/useBlock.tsx`). iOS freezes
the document and hands the same one back days later: nothing remounts and no navigation
happens, so a `now` pinned at mount is a "today" that quietly stops being today, against a
block last read on Tuesday. Both are refreshed on `visibilitychange` — the clock only when
the date under it has actually turned, or every glance at the phone would invalidate every
memo on screen, and the payload only when the one in hand is over 30s old. `online` is
wired to the same handler, because walking back into signal is when a phone showing a
cached block can stop.

**`now` is the wall clock, not the instant** (`wallClockNow` in `src/lib/block.ts`). Every
date here is the athlete's wall clock pinned to UTC — `startedOn` is `start_date_local`
parsed as UTC, `scheduledOn` is a UTC midnight, `BLOCK_START` is `Date.UTC`. `Date.now()`
is the one number in the app that is not, so handing it to `startOfDay` asks "which UTC day
is it" when the question was "which day is it here"; in Madrid those disagree until 01:00
or 02:00, which showed yesterday as *Hoy*. The conversion belongs where the instant enters
— once, in `useBlock` — because every consumer downstream of it is day-scale.

**The trace behind a run is read, not stored** (`src/lib/streams.ts`, `/actividad?id=`).
Tapping a row in `/registro` opens a detail view — pace, pulse, cadence and altitude over
distance, time in zones, per-km splits, laps and the description. `GET /api/activities/:id`
fetches the streams and the detailed record from Strava on every open (three calls, against
a 100-per-15-min limit) and folds the samples into 120 distance bins on the Worker, so the
phone receives ~12 KB, not ten thousand points. Nothing is written: a table of streams would
be a second copy of Strava's record for the one screen that reads it. The id must already
be in `activities`, so the endpoint cannot read arbitrary activities off the account. The
page is one prerendered shell; the id is in the query string and read in an effect (gotcha
15). Laps are shown only when they differ from the per-km auto-laps — a series session.

**Last season is data, not memory** (`src/lib/baseline.ts`). `docs/data/*.csv` is read
`?raw` at build time and parsed into `Activity` rows, so the 2025-26 build can be compared
against without a table, a sync or a second copy to keep honest. The *directory* is read
with `import.meta.glob(…, { query: '?raw', eager: true })` and its files classified by
name — `post-race` in a filename is the pre-block period and `build` is the previous
season — rather than by two named imports, so a fork drops its own exports in or deletes
them and the comparison goes quiet instead of failing to resolve a module. A file named
as neither is ignored rather than guessed at, because `docs/data/` is also where a raw
export lands on its way to being trimmed. An empty
directory has to degrade cleanly all the way down: `BASELINE_FIRST_WEEK` answers
`TOTAL_WEEKS` rather than `Infinity` when there is no baseline, and is floored at `0`
because a previous build longer than this block reaches back past `BLOCK_START` and would
otherwise report week −43.

The rows are shifted by `RACE_DATE - PREV_RACE_DATE` — both configuration, and 371 days,
exactly 53 weeks, at the defaults — which lands every one of them on the same weekday
*and* the same distance from race day. Pointing `PUBLIC_PREV_RACE_DATE` at the previous
edition of the same race is what keeps that a whole number of weeks. That is the only
alignment that
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
   A bare `wrangler deploy` reads the root config instead, whose `main` is the *source*
   entrypoint — wrangler's own esbuild cannot resolve Astro's virtual modules
   (`virtual:astro:app`, `astro:assets`, `virtual:astro-cloudflare:config`) and the deploy
   fails outright; even past that it resolves `assets.directory` wrongly. CI is Cloudflare
   Workers Builds, whose commands live in the dashboard rather than in the repo — build
   `pnpm test && pnpm build`, deploy and version both `-c dist/server/wrangler.json`. A
   dashboard left on the default bare `npx wrangler deploy` with no build command is the
   one way this bites in CI while `pnpm deploy` passes locally.
7. **D1 allows at most 100 bound parameters per query** — far tighter than SQLite's 999.
   Batch inserts derive rows-per-statement from the column count (`src/lib/sync.ts`) so
   adding a column cannot silently push a statement over the limit.
8. **Strava's callback domain is app-wide**, set once at strava.com/settings/api. It must
   match the deployed host or `/oauth/authorize` 400s before the consent screen renders.
   Currently `lamitja2027.iromero-py.workers.dev`, so OAuth does not complete against localhost.
   Every deployment needs its own Strava application for this reason, which is why
   `docs/setup.md` §b comes before the Cloudflare deploy: connect against the deployed
   URL, then develop locally.
9. **Strava rotates the refresh token on every refresh.** `src/lib/strava.ts` persists the
   new one each time; dropping it strands the app on a dead credential.
10. **`activity:read_all` is mandatory** — without it private activities are invisible and
    volume totals are silently wrong. The callback rejects a grant that lacks it.
11. **TypeScript 7 removed `baseUrl`**; use `paths` with `./` prefixes. Vite 8 resolves
    tsconfig paths natively (`resolve.tsconfigPaths: true`) — no plugin.
12. **pnpm 11 gates build scripts** via `allowBuilds` in `pnpm-workspace.yaml`. Without it
    `workerd` never installs its binary. `pnpm approve-builds --all` writes the right shape.
    `allowBuilds` is a pnpm 11 key and Workers Builds ships pnpm 10.11.1, which reads the
    file, silently ignores it and skips `workerd`'s postinstall — so `astro build` fails in
    CI on a machine where it passes locally. `packageManager` in `package.json` is what
    fixes it: pnpm 10 self-installs the pinned version and re-execs. Workers Builds has no
    version file for pnpm, only a `PNPM_VERSION` build variable, so the pin has to live in
    the manifest.
13. **`wrangler d1 execute --file` against remote is flaky** (upload step fails on transient
    network errors). Retry, or use `--command`.
14. **`?raw` imports work, including from outside `src/`.** `docs/data/*.csv` is inlined at
    build time by Vite — in the Worker bundle, in the prerender pass and in vitest alike.
    `astro/client` pulls in `vite/client`, so the module is typed without a declaration.
15. **A `client:load` island is also rendered during prerender**, in a Worker, where
    `location` and `window` do not exist. Touching either in a component body fails the
    build rather than the page — read them inside an effect or an event handler.
16. **tailwind-merge only knows the stock scales.** `cn()` decides conflicts by class
    *group*, and every `text-*` name it does not recognise falls through to `text-color` —
    so `cn('text-caption2', 'text-label-3')` read as two colours fighting over one slot and
    returned `text-label-3` alone, dropping the size. The whole ramp is custom and so is
    every colour, so this hit every element where a size met a colour. `src/lib/cn.ts`
    declares both lists to `extendTailwindMerge`; a token added to `@theme` and not there
    starts silently losing its size again. A knock-on: a `text-<size>` now also carries a
    line-height, so it displaces any `leading-*` written *before* it in the same `cn()` —
    put the leading after the size.
17. **Workers Assets redirects `/plan` to `/plan/` unless told not to.** The build emits
    `plan/index.html` and every link in the app is written without a trailing slash
    (`src/lib/nav.ts`), so the default `html_handling: "auto-trailing-slash"` answered the
    app's own most-repeated navigation with a 307 — a round trip before the first byte, on
    every tab tap, and a service-worker cache keyed under a path nothing links to.
    `"assets": { "html_handling": "drop-trailing-slash" }` in `wrangler.jsonc` makes the
    slash-less form canonical; the adapter carries the key through to the generated config.
18. **Astro's CSRF check is on**, so a `POST /api/login` without a matching `Origin` header
    comes back `403 Cross-site POST form submissions are forbidden` rather than 401. A
    browser sends it; `curl` has to be told to.
19. **`pnpm preview` needs `--persist-to`.** Wrangler resolves local storage relative to the
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
  the strap, and no decision in the plan is made on it. The zone floors are *shares* of
  `HR_MAX`, and `HR_MAX` itself comes from `config.ts` (`PUBLIC_HR_MAX`, default 192);
  both were calibrated against the two races in docs/01, not a textbook formula, so a fork
  measures its own maximum rather than taking 220 − age.
- **Units follow Strava**: metres, seconds, m/s. Paces (s/km) are derived at read time.
- **Cadence is stored as spm**, already doubled from Strava's rpm. 85 rpm ≈ 170 spm, and
  cadence is the primary marker in the knee protocol — halving it misreads the metric.
  It renders as `pasos/min`, never `ppm` — which in Spanish reads as heart rate.
- **Dates are INTEGER epoch milliseconds**, stored as the athlete's local wall clock, so
  "which day was this run" does not depend on the viewing device.
- **Pure logic stays out of I/O modules.** `src/lib/config.ts`, `src/lib/activity.ts`,
  `src/lib/block.ts`, `src/lib/plan.ts`, `src/lib/workout.ts`, `src/lib/paces.ts`,
  `src/lib/format.ts`, `src/lib/seed.ts`, `src/lib/metrics.ts`, `src/lib/analytics.ts` and
  `src/lib/baseline.ts` import nothing from `cloudflare:workers`,
  take `now` explicitly, and are unit-tested in plain Node; `src/lib/sync.ts` and
  `src/lib/strava.ts` own the side effects. `src/lib/mcp/*` belongs to the first group by
  taking its `Database` and its credential as arguments rather than reading either.
- **`plan.ts` and `workout.ts` ship to the browser, so they pull in neither drizzle nor
  zod.** They own `SESSION_TYPES` and `Step`, and `db/schema.ts` imports them, not the other
  way round; the zod mirror of `Step` lives in `plan-input.ts`, which only the Worker ever
  loads, and a type-level assignment there fails the build if the two drift apart.
- **The palette is a dark, vibrant evolution of Runna, and every colour in the app is a
  token.** The whole system is the `@theme` block in `src/styles/global.css`: three grounds
  (`surface-deep` `surface` `surface-raised`), `ink`, two fills, two lines, four label steps
  and eight named hues (`lime` `green` `mint` `blue` `violet` `coral` `red` `amber`).
  Nothing outside that file names a colour — no `neutral-*`, no `emerald-400`, no hex.
  There are exactly four exceptions, and every one of them is a place a custom property
  cannot reach: Strava's own `#fc4c02` on the connect button (`Dashboard.tsx`, and it is
  their brand rather than our palette); `theme-color` in `Base.astro`, because a `<meta>`
  cannot read a token; `background_color` and `theme_color` in
  `src/pages/manifest.webmanifest.ts`, because it is a JSON body; and the offline page in
  `public/sw.js`, because a service worker cannot import the stylesheet and a screen whose
  whole job is to appear when nothing else loaded may not depend on anything else loading.
  The last three are all `--color-surface`, plus `--color-label` and `--color-mint` on the
  offline page — **they are copies and they drift silently**, which has already happened
  once (`theme-color` sat at `#191b21` against a surface of `#12151a`). Change a ground and
  grep the hex. Two properties are
  load-bearing and easy to undo by accident: the ground is a **near-black cool charcoal,
  not a navy**, and the accents are high-chroma signals rather than pastel fills. Every hue
  clears 4.5:1 on *both* `surface` and `surface-raised`; re-derive that before changing one.
  `label-4` is the sole step that does not clear AA, so only chrome may use it.
- **Mint is state, not decoration.** Done, now, ahead, the primary button — one colour for
  "the app is telling you something", and `text-surface` is what rides on it. The other
  seven hues belong to the session types and the five zones.
- **Session colours are written out, never composed.** Tailwind resolves classes by scanning
  source, so the accent map in `src/components/ui/index.tsx` spells each class in full —
  `bg-${hue}` is a class that never ships.
- **The app is set in Inter and Manrope, self-hosted, and in nothing else** — the same
  pairing Runna sets its own app in, which is the other half of the sample this palette
  came from. `--font-sans` is **Inter** and is the app: every label, every row, every
  number in a grid. It is drawn for screens at small sizes, which is nearly all this app
  is — a taller x-height than the Geist it replaced (54.6% of the em against 53%), wider
  apertures, and a `1`/`l`/`I` that cannot be confused in `1:19:59` or `11,1 km`.
  `--font-display` is **Manrope**, and it is spent on exactly two roles: the page heading
  (`src/layouts/App.astro`, and the `<h2>` a detail or a sheet opens with) and the one hero
  number a screen is about (`HeroMetric`, the projection on `/progreso`, the metric above
  an activity's chart, the `1:19:59` on `/login`). Rounder and more geometric, so at 34px
  it reads as a *figure* rather than as large UI text — and at 11px it would read as
  neither, which is why `CardTitle`, `Stat` and every chip stay in Inter. Reach for it with
  the `font-display` class, and pair it with `font-bold`: Manrope was drawn to be set bold
  at headline sizes, and its variable default instance is 200, not 400. Both are one
  variable file per family (`public/fonts/inter-latin.woff2` 48 KB,
  `manrope-latin.woff2` 24 KB), both preloaded from `src/layouts/Base.astro` and declared
  `@font-face` in `global.css`, and both carry `tnum` so `data-number` means the same thing
  in either. They replaced a stack that led with `'Avenir Next'` and `'SF Mono'` — both
  Apple-only, so every label and every hero metric resolved to a different face on Android
  and Windows. Only the `latin` subset is shipped: `U+0000-00FF` carries every accent
  Spanish needs (á é í ó ú ñ ü ¿ ¡ ·) and the ranges above it carry the `—` and the `−`
  that `Delta` renders. Adding a glyph outside that range means adding a subset, not
  swapping a file. Note `font-display` is the *family* and `text-display` is the *size* —
  the hero metric wears both.
- **Type is one ramp, and the ramp is the only place a size comes from.** `caption2`
  `caption` `footnote` `subhead` `body` `title3` `title2` `title1` `display`, defined once
  in the `@theme` block. Not `text-sm`, not `text-xs`, not `text-[13px]` — those are what
  put three different heading sizes on three different screens the last time. Two steps are
  pinned and must not be "tidied": `body` is 17px because Safari zooms the whole page in on
  a focused input whose text is under 16px, and `caption2` at 11px is the floor for a label.
  Density is bought in the *leading*, never in the size.
- **Numbers are tabular figures, not a monospaced face** (`data-number` in `global.css`).
  The two get conflated and they are not the same thing: `font-variant-numeric: tabular-nums`
  equalises the ten digits and leaves everything else proportional, which is all this app
  ever wanted. A monospace face also puts the comma, the space and the slash on that same
  wide advance — and the app writes its decimals the Spanish way, so `47,3` came out spaced
  as `47 , 3` and `3,9 km` carried a double gap before the unit. Every distance, pace and
  split on every screen has one of those separators in it. `--font-mono` is now a system
  stack with no consumer; if something ever genuinely needs columns, reach for it knowingly.
- **The layout is compact on purpose.** The gutter is 12px, cards are `px-3 py-2.5` with
  `gap-2` between them, and the vertical rhythm inside a card runs 0.5 / 1 / 1.5 / 2 / 2.5 /
  3 — with `mt-3` as the gap between blocks in a card and `mt-2` / `mt-2.5` between a thing
  and its caption. Three is the ceiling, not a step to pass through: `mt-4` inside a card
  is the outer grid's spacing leaking inwards. What is *not* negotiable is the touch
  target: 44px is the floor, which is why `Button`, `Segmented` and every row control sit at `h-11` /
  `min-h-11` and the dock's columns at `h-12`. Shave the padding, never the target.
- **The UI reads everything from `/api/data` in one request** and derives the rest on the
  client. The block is a few tens of KB, so every mutation just re-reads it — there is no
  optimistic copy of the plan that can disagree with the database.
- Pages are prerendered. Only `src/pages/api/**` sets `export const prerender = false`.
- **`public/favicon.svg` is the icon master**; every PNG in `public/` is rasterised from it
  (`qlmanage -t -s <px> -o . favicon.svg`, macOS built-in — there is no image dependency).
  Edit the SVG and re-render all of them, or they drift. The mark is the La Mitja course
  profile: the climb through 10 km, then the descent that steepens to the finish.
- **Nothing in the repo is unreferenced.** Every asset is linked from `src/layouts/Base.astro`
  or `src/pages/manifest.webmanifest.ts`, every module is reachable from a page, the Worker or a
  test, and every `wrangler.jsonc` var is read by code. Keep it that way.
- **Secrets vs vars vs build-time config.** Three places, and which one a value belongs in
  is decided by who may read it and when. `STRAVA_CLIENT_SECRET`, `STRAVA_WEBHOOK_VERIFY`,
  `TOKEN_ENC_KEY` and `APP_PASSWORD` are secrets — `wrangler secret put` on the
  deployment, `.dev.vars` locally (`.dev.vars.example` documents all four). The Strava
  client ID is public, differs per deployment and is needed at request time, so it is a
  `wrangler.jsonc` var. The eleven `PUBLIC_*` values are public, differ per *fork* and are
  wanted as constants by pure modules, so they are `.env` and compiled in
  (`.env.example`). Adding a value means picking one of those three, not inventing a
  fourth.
