# Treximo

Training tracker for a sub-1:20 half marathon at La Mitja on **24 January 2027**.
Astro PWA on a single Cloudflare Worker, D1 for rows and private R2 for profile avatars.

**Scope is deliberately narrow: several athletes, invite-only, still small.** A handful of
friends, not a product — no teams, no roles beyond `is_admin`, no password reset by email
(the admin re-invites), no per-user rate limiting, no background queues. Each athlete has
their own login, their own Strava connection, their own block dates and their own plan.
Nothing before an athlete's block is synced for them — the owner's 2020–2026 history lives
in `docs/personal/data/*.csv`, and the app reads the 2025-26 season straight out of those files
(`src/lib/baseline.ts`) rather than storing a second copy of a finished record; it is the
owner's own history, and no other athlete compares against it. Read that constraint before
adding anything: it is why there is no outbox, no pagination, no rate-limit budget, no
tombstones and no materialised metrics.

Narrow is not the same as hard-coded. The repository is open source (MIT), and nothing
about *which* race is compiled in twice over. Each athlete's block — race, date, distance,
the Monday it opens on, the goal — is a row in `blocks`, read at request time and passed as
the first argument of everything that counts a week. The ten `PUBLIC_*` values in
`config.ts` are what a *deployment* is called and what a new athlete's form opens on; see
**The block's edges are configuration** below. Everything a forker follows once lives in
`README.md`, `docs/setup.md` and `LLM.md` — the same procedure as an executable runbook,
for an agent standing the project up on somebody's machine — and belongs there rather than
here: this file is for whoever is changing the code. The project is *Treximo*;
*La Mitja 2027* is the reference instance it ships configured as.

**The invariant that outranks everything else in this file: no query returns or writes a
row belonging to another athlete.** Every table but `users` and `invites` carries a
`user_id`, every key on them is composite, and every statement filters on it — including
the ones behind the MCP server, which is where it was got wrong first. `update_session`
and `delete_session` shipped keyed on `id` alone, which is not a key: ids are hand-chosen
slugs like `w03-tue-1` that two athletes pick independently, so one agent could rewrite
another's plan. It passed the type check, the whole unit suite and the build, and was
caught by two accounts and a curl. `test/unit/mcp.test.ts` now reads `tools.ts` and fails
if any statement in it does not name `userId` — a crude test for a bug that is invisible
to every ordinary one.

Training design (phases, volumes, paces, knee protocol): `docs/personal/03-training-plan-2027.md`
— the owner's, and gitignored along with the rest of `docs/personal/`.

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

Claim the owner account — once per database, against a schema at `0004` or later. The
migration plants the owner row with an empty `password_hash`; this is what gives it a real
one, and every later call 409s because no password hashes to empty:

```bash
curl -X POST http://localhost:8787/api/bootstrap \
  -H 'content-type: application/json' \
  -d '{"password":"$APP_PASSWORD","email":"tu@correo.com","newPassword":"al menos diez","displayName":"Ivan"}'
```

Everyone after that arrives through an admin-minted invite (`/ajustes` → Invitaciones →
`/alta?token=…`). `POST /api/login` takes JSON — `{email, password}` — not the form body it
used to: the endpoint validates with the same zod schemas as every other write, and those
parse an object rather than a multipart body of strings.

## Shape

**Eight tables** (`src/lib/db/schema.ts`, the source of truth — never hand-edit
`migrations/`):

| Table | Holds |
|---|---|
| `users` | One row per athlete: email, PBKDF2 password hash, display name, `is_admin`, HR max, baseline key, current avatar key. |
| `invites` | Single-use invite tokens (hashed), minted by an admin, redeemed once. |
| `blocks` | One row per athlete: block start, race date, goal time, race distance/name. |
| `strava_accounts` | One row per athlete who connected Strava: encrypted refresh token, athlete id, last sync time. |
| `activities` | Runs and rides inside an athlete's block, owned by `user_id`. Strava units, one row per activity. |
| `plan_weeks` | One row per athlete per week of their block: phase, volume target, down-week flag. |
| `plan_sessions` | The prescribed plan, one row per athlete per session, each with its workout as structured steps. |

**An avatar is one optimized object, not a second photo library** (`src/lib/avatar.ts`,
`PUT /api/avatar`). The browser respects the source orientation, centre-crops it once to a
512 × 512 image and uploads only that bounded representation; the original never reaches the
Worker and is never stored. The private R2 key is
`avatars/<authenticated-user-id>/<random-version>.<webp|jpg>`, and `users.avatar_key` names
the one current object.

**WebP where the browser can encode it, JPEG where it cannot — and the difference is
invisible to every other layer.** `canvas.toBlob` answers a type it cannot encode with a
*PNG*, not with an error, and WebKit does not encode WebP: on an iPhone the optimizer's
"is this WebP" check therefore rejected its own output at every quality and every photo
from the gallery died on `No se ha podido comprimir esta foto`. That check is right and
stays — the blob's own type is the only honest statement of what was produced — so the
optimizer now repaints on an opaque ground (JPEG has no alpha) and encodes JPEG when WebP
comes back as something else or as nothing. PNG would not do: lossless at 512 px it
routinely clears the 512 KB the endpoint accepts, which only moves the failure one step
later. The declared content type picks the header parser (`imageDimensions`), the stored
extension and what a later `GET` answers with, so those three cannot disagree; the
extension in the path — never R2's metadata — is what `/api/avatar/:version` sends under
`nosniff`. `test/unit/avatar-client.test.ts` fabricates WebKit's substitution and fails if
the fallback ever goes away. Every replacement gets a new key, so `/api/avatar/:version` can stream it
with a year-long private immutable browser cache; it checks that the requested version is
the one on `locals.user` before touching R2, so knowing another athlete's version still
cannot read it. Initials remain under the `<img>` as the no-photo and failed-load fallback.
Writes never take a user id. They update the caller's row optimistically against its previous
key, clean up a losing upload, and only delete an old object after the database points at the
new one — a cleanup failure can leave an unreachable object but never a broken current
avatar.

**The block's edges are configuration; everything else about it is code**
(`src/lib/config.ts`). Ten values are read from `import.meta.env.PUBLIC_*` with this
repository's own block as the defaults, so pointing the whole app at another race is a
`.env` rather than an edit to arithmetic. Seven are the block itself — the race's name,
date and distance, the Monday it opens on, the goal time, `HR_MAX`, and last season's
race. Three are *identity*: `APP_NAME`, `APP_SHORT_NAME` and `APP_DESCRIPTION`.

Identity is separate from `RACE_NAME` because they are different nouns — the event is
*La Mitja de Granollers* and the app is *Treximo*, one printed on a bib and the other on a
home screen — and a fork that could only override the race would end up with a tab reading
`Plan · Treximo` above a plan for Berlin, which is *correct*: the app's name is the one
name every athlete on a deployment shares, so it can never be any one of their races.
Between them the three reach every user-visible name in one hop: all eight `<title>`s,
`Boot.astro`'s wordmark, `/login`'s eyebrow and hero, `404`'s eyebrow, the meta
description, the Open Graph card, and the manifest. `/login`'s hero is `APP_NAME` set as
the wordmark, so the app's first impression is the last place a fork is greeted by
somebody else's name.

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
a *runtime* binding: reading it here would drag `block.ts`, `paces.ts`,
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

Two things now follow from those values instead of sitting beside them. `TOTAL_WEEKS` is
`ceil((RACE_DATE − BLOCK_START) / WEEK_MS)`. And the six pace bands are **ratios of goal pace** (`BAND_RATIOS`,
six decimals, each line carrying the pace it was derived from) rather than a table of
seconds — a ratio and not an offset because ability scales and offsets do not: goal pace
plus 73 s/km is a sane easy run for a 3:47/km runner and asks a 5:30/km one to jog at
6:43. At the default goal every ratio rounds back to exactly the second docs/03 §4 wrote
down.

Every value is validated at module load, so a typo fails the *build* rather than quietly
running a twenty-three-week block against the wrong year: blank counts as absent, a date has to
be a real calendar day, the block has to open on a Monday and run at least four weeks, and
last season's race has to precede this one. Those messages are English — they are read in
a build log by whoever just edited `.env`, not by the athlete. One gap to know about:
`vitest.config.ts` sets no `envPrefix`, and Vitest's default is `VITE_`, so a fork's
`.env` reaches the Astro build but *not* the unit tests, which run against the defaults.
Adding `envPrefix: 'PUBLIC_'` closes it, and correctly breaks the one place that asserts
the example block outright: `config.test.ts`'s *the block the app actually runs on* — which pins the live
`BLOCK_START`, `RACE_DATE`, `GOAL_TIME_S`, `HR_MAX` and the six-band `PACES` table, and
is the only test that proves `config.ts` is wired to its consumers rather than merely
parsing correctly. Those assertions are about the example block and belong with it.

`app_state` is gone — its two values (the refresh token, the last sync time) are per-athlete
now and live on `strava_accounts`. Every read and every write filters on `user_id`; there is
no query in the app that may return another athlete's row, and a missing filter is a bug of
the same class as a missing auth check.

**Every plan is authored, the owner's included — there is no seed.** `src/lib/seed.ts`,
`POST /api/plan/seed` and the `seed_plan` tool are gone: the owner's plan is rows in
`plan_weeks`/`plan_sessions` like every other athlete's, written and revised through the
MCP server (or by hand in `/plan`), with stable ids derived from week and weekday
(`w03-tue-1`) so re-running an authoring call rewrites the plan instead of duplicating it.
The plan's *design* lives where it always did — `docs/personal/` — and the database is the
one copy of it that runs. Every column that isn't structural is nullable and editable from
`/plan`, because phase boundaries and volume targets are expected to move as the knee
reports back.

Every other athlete gets a plan through `src/lib/generator.ts` instead — pure, browser-safe,
no drizzle, no zod, no clock, driven by a `PlanInput` (volume ramp, run/quality/strength
days, down-week cadence, extra races) the `/crear-plan` wizard collects. It reuses ideas
the plan machinery already proves rather than inventing new ones: phases scaled to the
block length, a capped linear ramp, quality sessions built from `workout.ts` steps at bands
derived from the athlete's own goal pace, and easy days that absorb whatever volume is left
over. `POST /api/plan/generate` replaces an athlete's plan wholesale — delete then insert,
inside one `db.batch` — which is why regenerating is a deliberate, warned-about action in
`/ajustes`, not a merge.

**A week's target is the sum of what its sessions prescribe.** Whoever authors a plan —
agent or hand — keeps `target_volume_m` equal to what the week's sessions add up to,
because a target no session adds up to is a number that quietly stops meaning anything.
The MCP server's instructions state the rule; nothing enforces it structurally, so an
authoring pass ends by reading the prescribed sums back and writing them into the weeks.

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
Monday is `block.startsOn + i * WEEK_MS`, not a column.

**The block is a value now, not a constant.** `src/lib/block.ts` still owns `DAY_MS`,
`WEEK_MS`, `startOfDay`, `startOfWeek`, `HALF_MARATHON_M` — but the four numbers that used
to be module-level constants (start date, race date, goal time, race distance) are now a
`BlockConfig`, one row per athlete in the `blocks` table. `LAMITJA_2027` is what's left of
the old constants: the owner's own block, the same numbers `docs/03` was written against,
kept around as the value the owner's `blocks` row is planted with and as what
`baseline.ts` is still hand-written against. Every function that used to close over the
constants now takes a `BlockConfig` as its first parameter — `block` is always first,
everywhere — because the alternative is a hidden global that silently mixes one athlete's
week index into another's plan. Paces move with it: `src/lib/paces.ts`'s six bands are no
longer literals but ratios of goal pace (`paceBands(goalPaceSKm(block))`), derived from the
one reference table `docs/03` prescribes, so another athlete's plan is paced at *their*
target rather than at Ivan's — `PACES`, the owner's table, is just `paceBands()` called with
the reference goal pace, and a test pins it equal to the original literals so it can never
silently drift. `hrZone` takes an `hrMax` argument now too; `HR_MAX` is renamed
`DEFAULT_HR_MAX` and is only the fallback for an athlete with no `hr_max` set.

A password behind a public URL is a password behind a *known* URL, so the two endpoints
that take a credential sit behind Cloudflare's `ratelimit` binding
(`src/lib/ratelimit.ts`, declared in `wrangler.jsonc`): `/api/login` at 8 a minute, and
`/api/mcp` at 60 — higher because a legitimate caller there is an agent writing a whole
block in a burst, not a person signing in. Three things about it are load-bearing.

*It is consulted before the credential, never after.* Counting only failures reads like
the kinder design and protects nothing: if a correct guess skips the limiter, every guess
is still checked and the only thing throttled is the status code the guesser gets back.
The cost is that a legitimate sign-in also counts, which at eight a minute nobody meets.
It is also what makes `/api/login`'s constant-time dummy hash affordable: 210k PBKDF2
rounds on an unauthenticated request is a denial-of-service lever right up until a caller
only gets eight of them a minute, and without it "no such account" returns in a
millisecond while "wrong password" takes 100 ms — a reliable oracle for which of a few
named friends has an account here.

*It fails open.* A missing binding — local `wrangler dev`, or a fork that dropped it —
means no limiting rather than no app. An app that will not let its owner in because a
rate limiter is unavailable has turned a hardening measure into an outage.

*It is a speed bump, not a lock.* The binding is per-Cloudflare-location and eventually
consistent, so a spread-out attacker gets a multiple of those numbers. The actual defence
is the entropy of the passwords themselves — which is why `auth-input.ts` will not accept
one under ten characters. And note a WAF rate-limiting rule is **not** an option
here: those are configured per zone, and `workers.dev` is not a zone you own.

**The plan is also an MCP server** (`src/lib/mcp/`, `POST /api/mcp`). Typing twenty-three
weeks of sessions into a form is the one thing this app is bad at and the one thing an
agent is good at, so the same data the UI reads is offered as ten tools: five reads —
the block brief, the weeks, the sessions, the activities, the derived summary — and five
writes, of which `create_sessions` exists so that "write me a 16-week plan" is one round
trip rather than ninety. A session written with `steps` gets its `targetDistanceM` derived
at the boundary (`withDerivedDistance`, in the athlete's own bands) — that column is what
every screen sums and what the activity matcher measures against, and the write is the
only honest moment to compute it.

**Bearer, and the token is *looked up*, not compared.** An MCP client has no cookie jar
and no login form to post to, so it presents `Authorization: Bearer <token>` — an
athlete's own token, minted on `/ajustes` and stored only as `sha256` in
`users.mcp_token_hash`, unique. `resolveMcpToken` hashes what was presented, finds the one
athlete it belongs to, loads their block, and returns a registry with their id closed over
every query behind it. A token belonging to nobody resolves to `null` and the request is
refused before its body is read.

That shape is deliberate and it is the fix for the class of bug described at the top of
this file: there is no way to *obtain* a registry without having established whose it is,
so a tool cannot accidentally run unscoped. It is a separate credential from the login
password on purpose — an MCP token lives in plain text in an agent's config file and gets
copied around, a password is typed; making them one string would mean handing an agent the
ability to sign in, and rotating the password to revoke an agent. `POST /api/mcp-token`
mints and replaces (that is how you rotate), `DELETE` revokes, and the plaintext exists in
one response body and nowhere else. `/api/mcp` sits in
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

`protocol.ts` knows the wire and nothing about training; `tools.ts` takes an `McpCtx` —
database, athlete id, block, `hrMax`, pace bands — so both are testable in plain Node with
a fabricated `Request`, no D1 and no bindings, and `src/pages/api/mcp.ts` is the only file
that knows where `env.DB` comes from. The context replaced a bare `Database` for a reason
worth keeping: a tool handed a connection can query anything, and a tool handed a context
has the athlete's id sitting next to it in the signature.

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
explicitly, in English, telling the agent to write those in Spanish. One deliberate
divergence from the HTTP surface is commented in place because it looks like drift:
`create_session`/`create_sessions` accept a client-chosen `id` and upsert on it (a stale
browser tab must not overwrite a session it never saw — an agent authoring a plan is the
opposite case, and without stable ids the same request run twice leaves two of every
session).

**Sync is one function with no cursor.** `syncBlock()` fetches everything after
`BLOCK_START` in a single request and upserts it. The block is one page of results, so
re-fetching the whole window costs one API call and removes every class of cursor-drift
bug — a renamed or corrected activity self-heals. The webhook triggers it (ignoring the
event body entirely — any event just means "refresh"), and a nightly cron is the safety net.

**Auth is per-user email + password, not Strava OAuth.** Strava OAuth is how the *server*
obtains an API token per athlete; making it the login would mean re-authorising on every
device, and it says nothing about who is allowed in. `src/lib/password.ts` hashes with
PBKDF2-SHA256 (210,000 iterations, WebCrypto's only KDF in a Worker — no bcrypt/argon2 WASM
for this scale) and a signed cookie (`src/lib/auth.ts`) is exchanged once and lasts a year,
working on desktop and iPhone alike. `SESSION_SECRET` signs that cookie; rotating it signs
every device out — that is the panic button. `APP_PASSWORD` is no longer the login: it is
the one-time bootstrap secret `POST /api/bootstrap` checks to give the owner row (created
with an empty password hash by the migration) its first real password, and it 409s once
that has happened. Everyone after the owner arrives through an admin-minted single-use
invite (`src/lib/invites.ts`) — the token is shown once, only its hash is stored, and
`/alta` redeems it. `src/middleware.ts` gates `/api/*` closed by default, with an explicit
public list, and also resolves the cookie to `context.locals.user` — a cookie whose user no
longer exists reads as signed out, which is how deleting a user revokes their devices.

**Sync is one function with no cursor, run per athlete.** `syncBlock(db, user)` fetches
everything after that athlete's `block.startsOn` in a single request and upserts it with
their `user_id` on every row. The block is one page of results, so re-fetching the whole
window costs one API call and removes every class of cursor-drift bug — a renamed or
corrected activity self-heals. The webhook now routes on the event's `owner_id`: it looks
up the matching `strava_accounts` row and syncs only that athlete (an unknown athlete id is
a 200 with no work — Strava must never see an error), and a nightly cron walks every
connected account, syncing each in turn and catching per-athlete so one dead refresh token
cannot skip the rest.

**Four tabs, one dock, and — since the rewrite below — one document.** `/` `/plan`
`/progreso` `/registro`, listed once in `src/lib/nav.ts` and rendered by
`src/components/Dock.tsx` — fixed to the bottom of the viewport, with
`env(safe-area-inset-bottom)` under it so it clears the home indicator.
`src/layouts/App.astro` is the prerendered document; `src/components/Shell.tsx` is the one
React root inside it that owns the column, the header, the dock and whichever screen the
URL names. `/login` uses `Base.astro` directly and has no dock.

**Every screen in the app is one document, and a tab tap is a `setState`**
(`src/components/router.tsx`). This is the single most load-bearing thing on this page and
it replaced the opposite design, so the reasoning matters more than the mechanism.

Each tab used to be its own prerendered page, swapped in by Astro's `<ClientRouter />`.
That cost a React teardown and a full rehydrate on every tap — and it could not rehydrate
*with the block*, because a prerendered shell in this app is skeletons and `useBlock`'s
`getServerSnapshot` has to return the empty payload or hydration is a mismatch. So the
first paint of the incoming tab was grey bars **by construction**, with the real data one
render behind it, and `::view-transition-new` is *live* — so the skeleton→data swap
happened in the middle of the 220ms cross-fade. Content, skeleton, content, on every tap,
with the payload sitting in memory the whole time. Six separate fixes had already been
spent on the layers around it (the page column's `transition:name`, `useSyncExternalStore`,
cache-first shells in the worker, `drop-trailing-slash`, the module-scope store, viewport
prefetch) and none of them could reach it: the thing being animated between was a shell,
and one of them was always empty.

So the seven screens are components of one tree. What follows from that:

- **The transition is real.** `document.startViewTransition`'s callback is a `flushSync`,
  so React has rendered the next screen — with the block, on its first render — before the
  browser captures the new snapshot. Both sides are content. The `flushSync` is not
  negotiable: without it React schedules the render on a `MessageChannel` task, a turn
  later, and the browser snapshots a page that has not changed yet.
- **The four tabs stay mounted.** `<Activity>` (React 19.2) keeps a hidden tab's state and
  DOM while unmounting its effects — `/plan` keeps the week you had open, `/registro` its
  filter — and hidden children are not server-rendered and render at a lower priority, so
  it costs the cold start nothing. `/sesion`, `/actividad` and `/ajustes` mount only while
  open: they are addressed by a query string or carry a form.
- **Scroll is the router's job.** The page scrolls the document, not a box, so `Activity`
  cannot hold an offset. `router.tsx` remembers one per route and the *order* is
  load-bearing: a route with no remembered offset is zeroed **before** the render, so a
  screen that positions itself on mount (`Planner` jumps to the current week, and checks
  `scrollY` first) reads where it is landing rather than where it came from; a route being
  returned to is restored **after**, because the offset is only a valid target once the
  content is back.
- **Links are intercepted, not rewritten.** One delegated `click` listener checks the path
  against `ROUTES` and swallows it only if this shell renders it. Several dozen
  `<a href="/sesion?id=…">` scattered through the screens needed no change, and `/login`,
  `/alta`, `/bienvenida` and `/api/*` stay real navigations — they are doors out of the
  app, not screens in it. `data-reload` on an anchor opts out.
- **`ROUTES` is data and the pages are markup, so nothing type-checks the join.** A route
  with no page is a deep link that 404s; a page naming a path that is not a key hydrates
  as `/` (the fallback in `make`), so `/progreso` would quietly open on Hoy. Both are
  clean under `tsc`. `test/unit/nav.test.ts` reads `src/pages/*.astro` and fails on either.
- **Astro is still the framework and still prerenders seven documents**, one per route,
  each opening on its own screen with real HTML in the first paint. They are entry points
  — a cold start, a deep link, a reload — not a single-page app that has to boot before it
  can route. What was deleted is `<ClientRouter />`, not Astro.

The dock's geometry is three custom properties in `global.css` — `--dock-bar-h`,
`--dock-inset`, `--dock-h` — because two files have to agree on it: the bar's own bottom
padding and the room `Shell.tsx` reserves under a page. They used to be two numbers typed
out separately with a comment asking whoever changed one to change the other.

**A fixed bar cannot see the keyboard, so it is told.** A `position: fixed` element is laid
out against the *layout* viewport, and the software keyboard does not shrink the layout
viewport — it covers it. So the dock sat behind the keyboard while iOS panned the visible
part of the page around underneath it, which on screen is a tab bar wandering across the
middle of the phone every time a filter on `/plan` or a field in a sheet is tapped.
`src/lib/keyboard.ts` watches `visualViewport`, flags `<html>` with `data-keyboard` when
the gap between the two viewports at the bottom edge exceeds a keyboard's worth of pixels,
and a rule in `global.css` slides the bar out on that flag — which is what a native tab bar
does. The flag lives on the root rather than in React because the thing that knows the
answer is the visual viewport, not a component — the same reason `data-offline` is there.
And `overscroll-behavior-y` is `none` **on `html`**, not `contain` on `body` where it used
to sit and did nothing at all — only the root's value is propagated to the viewport —
because the elastic bounce is the other thing that drags a fixed bar off the bottom edge
on iOS.

**Prefetching is off** (`astro.config.mjs`), and that is a consequence rather than a
tuning. It was `prefetchAll` at `tap`, with the four dock links opting up to `viewport`, so
the tab shells were in hand before a thumb moved. No screen fetches a document any more, so
warming those shells would download six copies of markup this session will never ask for.

Naming the page column is the one change to resist here. A `view-transition-name` lifts an
element into its own `::view-transition-group`, and a group animates the element's *box* —
so with a name on `<main>` every tab tap animated the full-document-height texture from
wherever the finger had left the scroll position to the top of the next screen,
interpolating a height between a one-screen `/` and a several-thousand-pixel `/registro` on
the way. On a phone that reads as the whole page lurching. Unnamed, the capture is the
viewport and the only thing animating is opacity. Name an element here only when you
actually want its box to travel — which is what `dock` and `dock-active` are, and the
second is a 60×48 pill.

**The launch screen covers the cold start, and only the cold start**
(`src/components/Boot.astro` + `src/lib/boot.ts`). A prerendered shell paints instantly and
then sits there empty: skeletons are the right answer for one late card and the wrong one
for a whole viewport of them, which is what tapping the home-screen icon used to show. So
`App.astro` renders an overlay, outside the island — `/login`'s tile, mark and wordmark, the
mark assembling itself, an indeterminate rail under it — server-side, in the first paint,
because an overlay a script has to *insert* arrives after the empty screen it was meant to
hide. The mark's motion is the brand's own idea rather than a leftover: the base fades in,
then the cúspide *settles into the gap above it* on `mark-apex`, because the separated apex
is what is still missing and so it is the piece that arrives. It replaced five strokes on
`chart-draw` — a dash animation cannot draw a fill, so the choreography had to be
re-thought rather than ported when the mark stopped being a line drawing.
Three rules keep it honest: `useBlock` clears it when the first `/api/data` settles, success
*or* failure (an error card with a retry on it is a screen to act on, not one to keep
hiding); `boot.ts` holds it for a 480ms floor measured from the page opening, so an edge-fast
launch does not flash a half-assembled mark; and an inline dead-man switch drops it at 2.6s
whatever happened, with `<noscript>` removing it outright. The one path that does *not*
dismiss it is the 401 redirect to `/login` — the document is already leaving, and uncovering
it first would flash a screenful of skeletons on the way out. It used to carry
`transition:persist="boot"`, because `ClientRouter` swapped the whole body and the incoming
page's copy would otherwise flash on every tab tap; with the tabs in one document there is
no swap left and nothing to persist. It is still left in the DOM hidden rather than removed
(`visibility`, on a delayed step after the fade, so it stops swallowing taps).

**`/404` is `/login`'s sibling, not a tab** (`src/pages/404.astro`). It wears `Base`, so it
has no dock: the lit tab is baked in at build time and a 404 belongs to none of the four, so
the bar would sit there with nothing highlighted on the one screen whose message is that you
are nowhere. `404` takes the hero-number slot the goal time takes on `/login`, in `label`
rather than red — a mistyped URL is not a failure of the training block — and there is one
way out rather than a menu. It is prerendered like everything else; Astro serves it through
the adapter's `prerenderedErrorPageFetch`, so an unmatched path comes back as a real 404
status with this HTML in it instead of the asset handler's bare "Not Found".

**The app works without a connection, and says so when it is** (`public/sw.js`,
`src/lib/pwa.ts`, `src/lib/net.ts`, `OfflineNotice` in `src/components/Shell.tsx`). This is a plan
read at a trailhead and in a car park, so a launch with no signal may not end on the
browser's error page inside a window with no address bar. The service worker is
hand-rolled for the same reason the charts are: Workbox is a build step and a dependency
for four caching rules.

*Network-first for anything that can change, cache-first for anything that cannot.*
`/api/data` goes to the network and falls back to the cache, so a fresh sync is never
hidden behind a stale copy; `/_astro/*` and the precached fonts go the other way, because
a content hash *is* a version. The block payload is never stale-while-revalidate — that
would hand the phone yesterday's plan while today's was still in flight, on an app whose
whole content is "what am I doing today".

The shells sit in between, and they are network-first: a shell request is now always a
real navigation — a launch, a reload, a link from outside — and that request is what boots
the app, so a stale one there asks for `/_astro/*` chunks the last deploy removed. There
used to be a second route through `page()`, answering from the cache and revalidating
behind it, because a tab tap was a `ClientRouter` swap fetching the next shell and
network-first put a round trip in front of every one. The tabs are one document now, so a
tab tap fetches nothing and the split — along with the two functions that told the callers
apart — is gone.

Four caches, and the split is the design. `lm-core` is precached at install: fonts, mark,
manifest — stable URLs, so **bump `VERSION` when one of them is edited**. `lm-pages` holds
the shells keyed by *pathname with the query dropped*, because `/actividad?id=1` and
`?id=2` are one prerendered document and per-URL keys would store it once per run in the
log. `lm-assets` is deliberately **not** versioned and is LRU-trimmed to 60 entries: a
hashed filename cannot go stale, only become surplus, and purging it on an update would
throw away a good copy of a file that is still current. `lm-data` holds one entry.

One consequence of the collapse is worth knowing, because it is an improvement rather
than a compromise. A device that has only ever launched `/` now has only `/` in `lm-pages`
— the other shells are never requested, so they are never cached — so opening `/plan`
offline falls back to the `/` document. That is the right answer: every screen lives in
that document, and the shell reads the real `location` as it hydrates, so it opens on the
plan. It used to open on Hoy.

Shells are cached as they are visited rather than precached, which is what makes this
need no build step: a deploy can never leave a stale shell pointing at a hashed chunk that
no longer exists. The payload cache holds private training data in an origin-scoped store
on the athlete's own phone — the same footing as the session cookie — and is dropped the
moment `/api/data` answers 401, which is how rotating `APP_PASSWORD` reaches it. A payload
served from it carries `x-lm-stale`, `useBlock` reads that, and the offline notice says on
screen that the numbers are from the last sync rather than from now: "42 km this week" and
"42 km the last time this phone had signal" are the same pixels and different facts. The
flag lives on `<html>` rather than in React state because two things know the answer and
neither is a component — the browser's `online`/`offline` events and that header — and
because the app shell never leaves the document it booted in. Registration is
production-only and `test/unit/sw.test.ts` runs the shipped file against stub caches.

**An installed app is resumed, not reopened** (`src/components/useBlock.tsx`). iOS freezes
the document and hands the same one back days later: nothing remounts and no navigation
happens, so a `now` pinned at mount is a "today" that quietly stops being today, against a
block last read on Tuesday. Both are refreshed on `visibilitychange` — the clock only when
the date under it has actually turned, or every glance at the phone would invalidate every
memo on screen, and the payload only when the one in hand is over 30s old. `online` is
wired to the same handler, because walking back into signal is when a phone showing a
cached block can stop.

**The block is read once per document, through a store rather than a variable**
(`src/components/useBlock.tsx`). Two things forced that shape and both had already gone
wrong.

*A page carries two islands.* The screen and the header's avatar are separate React roots,
so a payload read into each one's `useState` was two copies of one block: two `/api/data`
requests racing on every cold start, and two answers to "who is signed in" after a rename.
One store with two subscribers is one request. `HeaderAvatar` also subscribes through
`useBlockSource` rather than `useBlock` — two letters do not need `buildBlock` matching
every session against every activity, and that derivation was running twice per page, on
the frame a tab transition was animating.

*And the read has to be `useSyncExternalStore`.* The prerendered shell ships the
**skeleton** — it was built with no athlete — so an island whose first client render read
the cache produced the **block** instead, and disagreed with the HTML it was hydrating. A
hydration mismatch is not a warning: React throws the server markup away and re-renders
the whole screen from scratch. That full re-render landed in the middle of the 220 ms tab
transition, on every tab tap after the first. `getServerSnapshot` returns the empty
snapshot so hydration matches, and the real one is adopted in the layout effect that runs
straight after, before the frame is painted.

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

**Last season is data, not memory, and it is the owner's data alone** (`src/lib/baseline.ts`).
`docs/personal/data/*.csv` is imported `?raw` and parsed into `Activity` rows, so the 2025-26 build
can be compared against without a table, a sync or a second copy to keep honest — but it is
one athlete's finished record, not a generic feature, so it sits behind `baselineFor(key)`
and only the athlete whose `users.baseline_key` names it (`BASELINE_KEY = 'ivan-2025-26'`,
the owner only) ever sees a comparison; everyone else's `baselineFor` returns `null` and the
UI renders nothing rather than a stranger's season. The rows are shifted by
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
in `docs/personal/data` that carry one (±33%, so `estimatedShare` reports how much of a window
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
14. **`?raw` imports work, including from outside `src/`.** `docs/personal/data/*.csv` is inlined at
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
  `PACE_ZONE_NUMBER` maps each pace band onto a zone, and `hrZone(bpm, hrMax)` maps an
  average heart rate onto one. The exact bpm is never rendered — it drifts with heat, sleep
  and the strap, and no decision in the plan is made on it. `DEFAULT_HR_MAX` and the zone
  floors are calibrated against the two races in docs/01, not a textbook formula, and are
  only the fallback for an athlete with no `hr_max` of their own set in `/ajustes`.
- **Units follow Strava**: metres, seconds, m/s. Paces (s/km) are derived at read time.
- **Cadence is stored as spm**, already doubled from Strava's rpm. 85 rpm ≈ 170 spm, and
  cadence is the primary marker in the knee protocol — halving it misreads the metric.
  It renders as `pasos/min`, never `ppm` — which in Spanish reads as heart rate.
- **Dates are INTEGER epoch milliseconds**, stored as the athlete's local wall clock, so
  "which day was this run" does not depend on the viewing device.
- **Pure logic stays out of I/O modules.** `src/lib/config.ts`, `src/lib/activity.ts`, `src/lib/block.ts`,
  `src/lib/plan.ts`, `src/lib/workout.ts`, `src/lib/paces.ts`, `src/lib/format.ts`,
  `src/lib/generator.ts`, `src/lib/metrics.ts`, `src/lib/analytics.ts`
  and `src/lib/baseline.ts` import nothing from `cloudflare:workers`,
  take `now` explicitly, and are unit-tested in plain Node; `src/lib/sync.ts` and
  `src/lib/strava.ts` own the side effects. `src/lib/mcp/*` belongs to the first group by
  taking its `Database` and its credential as arguments rather than reading either.
- **`plan.ts` and `workout.ts` ship to the browser, so they pull in neither drizzle nor
  zod.** They own `SESSION_TYPES` and `Step`, and `db/schema.ts` imports them, not the other
  way round; the zod mirror of `Step` lives in `plan-input.ts`, which only the Worker ever
  loads, and a type-level assignment there fails the build if the two drift apart.
- **The ground is painted on `html`, and the atmosphere above it is a fixed pseudo-element**
  (`body::before`, `--app-atmosphere` in `global.css`; `Boot.astro` paints the same token so
  the splash and the screen it uncovers are one surface). It was `background-attachment:
  fixed` on the body, which is the single most expensive thing this stylesheet could ask a
  phone for — WebKit cannot hand a viewport-anchored background to the compositor, so the
  page drops off the fast scrolling path and repaints the full viewport every frame — and
  on iOS it is also the declaration most likely to be ignored outright. The body carries no
  background of its own now, and must not: a negative-z layer paints after the *root's*
  background and before the *body's*, so a `bg-surface` on `<body>` would cover it.
- **The palette is a dark, vibrant evolution of Runna, and every colour in the app is a
  token.** The whole system is the `@theme` block in `src/styles/global.css`: three grounds
  (`surface-deep` `surface` `surface-raised`), `ink`, `bone`, two fills, two lines, four
  label steps and eight named hues (`lime` `green` `mint` `blue` `violet` `coral` `red`
  `amber`). Nothing outside that file names a colour — no `neutral-*`, no `emerald-400`,
  no hex. There are exactly four exceptions, and every one of them is a place a custom
  property cannot reach: the mark's own two inks, baked into `favicon.svg`, `icon.svg`,
  `icon-maskable.svg`, `mark.svg` and every PNG exported from them, because an SVG served
  out of `public/` never sees the stylesheet; `theme-color` in `Base.astro`, because a
  `<meta>` cannot read a token; `background_color` and `theme_color` in
  `src/pages/manifest.webmanifest.ts`, because it is a JSON body; and the offline page in
  `public/sw.js`, because a service worker cannot import the stylesheet and a screen whose
  whole job is to appear when nothing else loaded may not depend on anything else loading.
  The last three are all `--color-surface`, plus `--color-label` and `--color-mint` on the
  offline page — **they are copies and they drift silently**, which has already happened
  once (`theme-color` sat at `#191b21` against a surface of `#12151a`). Change a ground and
  grep the hex; the icons carry `--color-accent` and `--color-bone` and want the same grep.
  Three properties are load-bearing and easy to undo by accident: the ground is a
  **near-black cool charcoal, not a navy**, it is the brand's *carbón* `#13151A` exactly so
  the home-screen icon and the app behind it are one surface, and the accents are
  high-chroma signals rather than pastel fills. Every hue clears 4.5:1 on *both* `surface`
  and `surface-raised`; re-derive that before changing one. `label-4` is the sole step that
  does not clear AA, so only chrome may use it.
- **`accent` is the brand's orange, and it used to be Strava's.** `#FC4C01` is the apex of
  the mark; `#fc4c02` was the connect button. They are one digit apart, which is why the
  swap cost nothing and why `Dashboard.tsx` still puts `bg-accent` on the Strava action and
  still reads as Strava's colour — but the token is ours now, and every other use of it
  (today's date, race day, the focus ring, the selection) is the app speaking in its own
  voice rather than borrowing. The brand sheet's one rule about it: never the base of the
  mark, never carbón on the apex, and never a second accent beside it.
- **Mint is state, not decoration.** Done, now, ahead, the primary button — one colour for
  "the app is telling you something", and `text-surface` is what rides on it. The other
  seven hues belong to the session types and the five zones.
- **Session colours are written out, never composed.** Tailwind resolves classes by scanning
  source, so the accent map in `src/components/ui/index.tsx` spells each class in full —
  `bg-${hue}` is a class that never ships.
- **The app is set in Inter and Manrope, self-hosted, and in nothing else — and the
  *brand* is set in Schibsted Grotesk, which is not the same claim.** Inter and Manrope are
  the pairing Runna sets its own app in, which is the other half of the sample this palette
  came from, and between them they set every pixel inside a screen. `--font-brand` is
  **Schibsted Grotesk** and it never appears inside one: it is spent on a single role, the
  wordmark, on the four surfaces that carry a lockup — the launch overlay, `/login`,
  `/alta` and `/404`. Reach for it through `wordmark` and never through `font-brand`
  directly, because the face is only a third of the logotype: the utility also pins weight
  400, `lowercase` and `.12em`, and the brand sheet forbids each of the three ways of
  getting that wrong ("nunca en mayúsculas, nunca en negrita, nunca condensada"). It is the
  one static font in the app — 400 and nothing else, because nothing is permitted to use a
  second weight — and it is subset to the same latin range as the other two rather than to
  the seven letters of *treximo*, because `APP_NAME` is configuration and a fork's own name
  has to render in it. All three are OFL 1.1; `public/fonts/LICENSE.md` carries the notice.
  `--font-sans` is **Inter** and is the app: every label, every row, every
  number in a grid. It is drawn for screens at small sizes, which is nearly all this app
  is — a taller x-height than the Geist it replaced (54.6% of the em against 53%), wider
  apertures, and a `1`/`l`/`I` that cannot be confused in `1:19:59` or `11,1 km`.
  `--font-display` is **Manrope**, and it is spent on exactly two roles: the page heading
  (`src/components/Shell.tsx`, and the `<h2>` a detail or a sheet opens with) and the one hero
  number a screen is about (`HeroMetric`, the projection on `/progreso`, the metric above
  an activity's chart). Rounder and more geometric, so at 34px
  it reads as a *figure* rather than as large UI text — and at 11px it would read as
  neither, which is why `CardTitle`, `Stat` and every chip stay in Inter. Reach for it with
  the `font-display` class, and pair it with `font-bold`: Manrope was drawn to be set bold
  at headline sizes, and its variable default instance is 200, not 400. Inter and Manrope
  are one variable file per family (`public/fonts/inter-latin.woff2` 48 KB,
  `manrope-latin.woff2` 24 KB) and Schibsted Grotesk one static instance
  (`schibsted-grotesk-latin.woff2` 24 KB); all three are preloaded from
  `src/layouts/Base.astro` and declared `@font-face` in `global.css`, and Inter and Manrope
  carry `tnum` so `data-number` means the same thing
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
- **There is no single icon master, and that is the point.** The mark is a soft delta whose
  apex is cut away from its base — the symbol for change, with the piece that is still
  missing left missing — and it is drawn *twice*, because a shape that reads at 512 px does
  not read at 16. `public/icon.svg` (rounded tile, mark at 56%) is what
  `apple-touch-icon.png`, `icon-192.png` and `icon-512.png` are rasterised from;
  `icon-maskable.svg` (full bleed, mark at 45%, so it survives a circular crop) produces
  `icon-maskable-512.png`; and `favicon.svg` carries its **own thicker geometry** at 70% for
  `favicon.ico`, because at 16 px the apex and the gap each need a whole pixel. Edit one and
  re-render only what comes out of it. `public/mark.svg` is the fourth: the bare mark with
  no tile, which is what `/login`, `/alta` and `/404` show — they already sit in a tile the
  app drew, and nesting the gradient azulejo inside it would be a tile in a tile.
  `Boot.astro` **inlines** that same geometry rather than loading it, because its two shapes
  animate separately and a document cannot reach inside an `<img>`. `public/og.png` comes
  from `scripts/brand/og.html` — HTML and not SVG, so the wordmark is genuinely *set* in the
  brand face rather than left to whatever a rasteriser has installed. And `sw.js` precaches
  `favicon.svg` and `icon-192.png`, so its `VERSION` moves whenever either does.
  The full brand kit — contact sheet, lockup, the colour and typography rules quoted
  throughout this file — is `docs/personal/treximo-logo-design-concepts/`, which is
  gitignored: it is the source the repository's own assets were exported from, not a
  dependency of the build.
- **Nothing in the repo is unreferenced.** Every asset is linked from `src/layouts/Base.astro`
  or `src/pages/manifest.webmanifest.ts`, every module is reachable from a page, the Worker or a
  test, and every `wrangler.jsonc` var is read by code. Keep it that way. The manifest lists
  both SVG masters as icons for exactly this reason — they are the source of the PNGs above
  them *and* a crisp icon for any launcher that prefers vector art.
- **Secrets vs vars vs build-time config.** Three places, and which one a value belongs in
  is decided by who may read it and when. `STRAVA_CLIENT_SECRET`, `STRAVA_WEBHOOK_VERIFY`,
  `TOKEN_ENC_KEY` and `APP_PASSWORD` are secrets — `wrangler secret put` on the
  deployment, `.dev.vars` locally (`.dev.vars.example` documents all four). The Strava
  client ID is public, differs per deployment and is needed at request time, so it is a
  `wrangler.jsonc` var. The ten `PUBLIC_*` values are public, differ per *fork* and are
  wanted as constants by pure modules, so they are `.env` and compiled in
  (`.env.example`). Adding a value means picking one of those three, not inventing a
  fourth.
