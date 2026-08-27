# Setup

Everything needed to run this app as your own: a Strava application, a Cloudflare Worker,
your race in a `.env`, and an agent authoring your plan through the MCP server.

This is the version written for a person, with the reasoning attached. The same ground as
a checklist an agent can execute — local first, then a deliberate stop before anything is
created on your Cloudflare account — is [`../LLM.md`](../LLM.md).

Follow it in order. The one step that cannot be reordered is the first: Strava's
authorization callback domain is a single app-wide field, so you have to know the address
your Worker will answer on before you can connect Strava to it at all — and that means
deploying before you develop, not after.

---

## a. Before you start

| | |
|---|---|
| **Node** | 22.12 or newer (`engines` in `package.json`). |
| **pnpm** | Do not install a version — `packageManager` pins `pnpm@11.1.2` and any pnpm 10+ self-installs it. Never npm or yarn: `pnpm-workspace.yaml` carries the `allowBuilds` entry that lets `workerd` unpack its binary. |
| **Cloudflare** | A free account is enough. Workers, one D1 database, one KV namespace and a cron trigger all fit inside the free plan at this size. `wrangler login` once. |
| **Strava** | An ordinary athlete account. The developer application below is created from it. |

---

## b. Your own Strava API application

Every deployment talks to Strava as its own application. There is no shared client id in
this repository to borrow — the one in `wrangler.jsonc` is the author's, it is bound to
the author's callback domain, and OAuth against it from your host returns 400 before the
consent screen renders.

### The application

Go to **<https://www.strava.com/settings/api>** and create one. The fields that matter:

| Field | What to put |
|---|---|
| **Application Name** | Anything. It is what the consent screen says is asking for access. |
| **Category** | *Training* is the honest one. |
| **Website** | Your deployed URL, or any URL. Strava does not check it. |
| **Authorization Callback Domain** | **The bare host, no scheme and no path** — `lamitja2027.iromero-py.workers.dev`, or `training.example.com` if you put the Worker behind a custom domain. Not `https://…`, not `…/api/strava/callback`. |
| **Icon** | Optional. |

### The callback domain is app-wide, and it is why you deploy first

That domain is a property of the *application*, not of an individual redirect URI. Strava
checks it before rendering the consent screen, so a mismatch fails as an opaque `400` on
`/oauth/authorize` and never reaches a page that could explain itself. This is the single
most likely thing to cost you an afternoon.

The consequence: **OAuth cannot complete against `localhost`** while that field names your
deployed host. Deploy first (section c), connect Strava against the deployed URL, and
develop locally afterwards. That order costs nothing, because connecting is a one-time
act — the refresh token lands in D1 and the app keeps it there.

If you do want Strava connected to a *local* database, point the field at `localhost`
while you do it and then point it back. Bear in mind the local and remote D1 are separate
databases with separate tokens, and while the field says `localhost` the deployed app
cannot connect at all.

### Scopes

`src/lib/strava.ts` requests `read,activity:read_all`, and **`activity:read_all` is not
optional**. Without it Strava simply omits private activities from the API — no error, no
gap, just quietly smaller weeks — so every volume total, every ramp and every comparison
against last season would be wrong in a way nothing on screen could show you. On the
consent screen that is the *"View data about your private activities"* box; leave it
ticked. `src/pages/api/strava/callback.ts` rejects a grant that comes back without it and
returns you to `/?strava=scope` rather than storing a token that under-reports.

### The two keys

The application page shows both:

- **Client ID** — public. It appears in every OAuth redirect, so it lives in
  `wrangler.jsonc` under `vars.STRAVA_CLIENT_ID`, in the repository, not in a secret.
- **Client Secret** — secret. `wrangler secret put STRAVA_CLIENT_SECRET` for the
  deployment, and `.dev.vars` for local development.

### Token rotation, and one thing not to regenerate

Strava rotates the refresh token on **every** refresh: the response to a token refresh
carries a new refresh token and invalidates the one you used. `src/lib/strava.ts`
persists the new one each time, encrypted with `TOKEN_ENC_KEY` (AES-GCM) so a leaked
database export is not a leaked Strava account.

That encryption is the reason `TOKEN_ENC_KEY` must be treated as permanent on a live
deployment. Rotate it and the stored token stops decrypting; the app cannot refresh, the
sync fails, and the fix is to reconnect Strava from `/`. Rotating it is fine — just know
that reconnecting is part of it.

### The webhook subscription

The webhook is what makes a run appear in the app a few seconds after the watch uploads
it. It is optional: `wrangler.jsonc` also schedules a nightly cron at 03:00 UTC that runs
the same sync, so a deployment with no subscription is a deployment that is up to a day
behind, not one that is broken.

`STRAVA_WEBHOOK_VERIFY` is a random string you invent. Strava echoes it back at
subscription time and `src/pages/api/strava/webhook.ts` compares it in constant time —
it is what stops anyone else from pointing a subscription at your callback.

Set the secret and deploy **before** creating the subscription: Strava validates the
callback synchronously, with a two-second budget, and a Worker that does not yet know the
verify token answers `403` and the subscription is refused.

```bash
# Create it. Strava immediately GETs the callback with hub.mode / hub.challenge /
# hub.verify_token, and the route echoes {"hub.challenge": "…"} back.
curl -X POST https://www.strava.com/api/v3/push_subscriptions \
  -F client_id=YOUR_CLIENT_ID \
  -F client_secret=YOUR_CLIENT_SECRET \
  -F callback_url=https://your-worker-host/api/strava/webhook \
  -F verify_token=YOUR_STRAVA_WEBHOOK_VERIFY
# → {"id": 123456}
```

```bash
# What is subscribed right now (an application may only have one subscription).
curl -G https://www.strava.com/api/v3/push_subscriptions \
  -d client_id=YOUR_CLIENT_ID \
  -d client_secret=YOUR_CLIENT_SECRET

# Remove it — the id from either call above.
curl -X DELETE "https://www.strava.com/api/v3/push_subscriptions/123456?client_id=YOUR_CLIENT_ID&client_secret=YOUR_CLIENT_SECRET"
# → 204 No Content
```

The `POST` the subscription then delivers on every activity is answered immediately and
the sync runs in `waitUntil`, because Strava disables a subscription whose callback keeps
taking longer than about two seconds. The event body is ignored entirely: a sync is one
full-block fetch, so any event just means "something changed, refresh".

---

## c. Deploying to Cloudflare

### 1. Install, and log in

```bash
pnpm install
pnpm exec wrangler login   # opens a browser; approve, then come back
pnpm exec wrangler whoami  # which account everything below will land on
```

`pnpm exec`, not a bare `wrangler`: it is a devDependency of this repository rather than a
global, so a fresh clone has it in `node_modules/.bin` and nowhere else. The `pnpm` scripts
(`db:migrate`, `deploy`, `cf-typegen`) resolve it the same way, which is why they are
written without the prefix.

`wrangler login` is a browser OAuth flow and has no non-interactive form. On a headless
machine, export a `CLOUDFLARE_API_TOKEN` instead — scoped to *Workers Scripts: Edit*,
*D1: Edit* and *Workers KV Storage: Edit* — and skip the login entirely.

### 2. Create the database and the KV namespace

```bash
pnpm exec wrangler d1 create my-training
pnpm exec wrangler kv namespace create CACHE
```

Each prints a config block. Copy the ids into `wrangler.jsonc`:

- `d1_databases[0].database_name` and `database_id` — replace both; `wrangler d1 create`
  printed the pair.
- `kv_namespaces[0].id` — replace `ddbcc843…`. KV holds exactly one thing: the single-use
  OAuth state token.
- `name` — the Worker's name, and therefore its address:
  `https://<name>.<your-subdomain>.workers.dev`. This is the host that has to match the
  Strava callback domain from section b.

The ids currently in the file are the author's. They are not secret and they are not
usable: against another Cloudflare account they resolve to nothing and every deploy fails
on a missing binding.

Name the database whatever you like. The `db:*` scripts in `package.json` address it as
`DB`, the binding, which wrangler accepts anywhere it takes a database name — so
`wrangler.jsonc` is the only file that knows what you called it.

Then regenerate the binding types:

```bash
pnpm cf-typegen
```

### 3. The four secrets

```bash
pnpm exec wrangler secret put APP_PASSWORD           # the login. One password, all your devices.
pnpm exec wrangler secret put STRAVA_CLIENT_SECRET   # from the Strava application page
pnpm exec wrangler secret put STRAVA_WEBHOOK_VERIFY  # any random string; used once, at subscribe time
pnpm exec wrangler secret put TOKEN_ENC_KEY          # openssl rand -base64 32 — exactly 32 bytes
```

Each prompts for the value; each also reads standard input, so
`printf '%s' "$SECRET" | pnpm exec wrangler secret put APP_PASSWORD` works when a prompt
would not — in a script, or with an agent driving.

`TOKEN_ENC_KEY` must decode to 32 bytes or the app refuses it at the point of use;
`openssl rand -base64 32` produces exactly that. If wrangler says there is no Worker by
that name yet, let it create one — the deploy in the next step replaces it and the
secrets survive.

Nothing else is a secret. The Strava **client id** is public and belongs in
`wrangler.jsonc`, and so is everything in `.env` — a race date and a goal time are printed
on the start list.

### Before you make the repository public

Publishing the repository publishes the URL of a password-protected app holding your
training history, together with the source that explains exactly how the door works. Two
things follow.

**Make `APP_PASSWORD` long and random.** You type it once per device per year, so length
costs you nothing and costs an attacker everything:

```bash
openssl rand -base64 24 | pnpm exec wrangler secret put APP_PASSWORD
```

**The rate limits are already there, and they are only a speed bump.** `/api/login` is
capped at 8 requests a minute per IP and `/api/mcp` at 60, through Cloudflare's
`ratelimit` binding declared in `wrangler.jsonc`. They are per-Cloudflare-location and
eventually consistent, so a distributed attacker gets a multiple of those figures — which
is why the password above matters more than the limits do. Delete the `ratelimits` block
and the app still runs, unthrottled: `src/lib/ratelimit.ts` fails open on purpose.

A WAF rate-limiting rule would be the obvious alternative and is not available on a
`workers.dev` host: WAF rules are configured per zone, and that is Cloudflare's zone, not
yours. On a custom domain you can add one.

Optional, and a genuine step up: put [Cloudflare Access](https://developers.cloudflare.com/workers/configuration/cloudflare-access/)
in front of the Worker (**Workers & Pages** → your Worker → **Access**). Sign-in then
happens at the edge against your identity provider, with MFA, before the Worker runs. Two
caveats if you do: `/api/strava/webhook` needs a **Bypass** policy, because Strava's
servers cannot authenticate; and `/api/mcp` needs a **Service Auth** policy plus a
[service token](https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/),
whose `CF-Access-Client-Id` and `CF-Access-Client-Secret` go alongside the bearer header
in `claude mcp add`. Access is a deployment choice, not something this app depends on — a
fork with no Zero Trust configured is still protected by the password.

### 4. Migrate, then deploy

```bash
pnpm db:migrate    # wrangler d1 migrations apply DB --remote
pnpm deploy        # astro build && wrangler deploy -c dist/server/wrangler.json
```

**Never run a bare `wrangler deploy`.** It reads the root `wrangler.jsonc`, whose `main`
is the *source* entrypoint, and wrangler's own esbuild cannot resolve Astro's virtual
modules (`virtual:astro:app`, `astro:assets`, `virtual:astro-cloudflare:config`); the
deploy fails outright, and even past that it resolves the assets directory wrongly. The
config to deploy is the one the Astro adapter *generates*, `dist/server/wrangler.json`,
which is what `pnpm deploy` does. This is gotcha 6 in `AGENTS.md`.

### 5. Sign in, connect, and get a plan into the database

Open the deployed URL. It redirects to `/login`; the password is `APP_PASSWORD`, and it
is exchanged for a signed cookie good for a year, on every device you enter it on.
Rotating `APP_PASSWORD` invalidates every one of those cookies at once — that is the
sign-out-everywhere switch, and it also drops the offline payload cached on each phone.

Then press **Conectar con Strava** on the home screen and accept the consent screen with
the private-activities box ticked. The callback stores the token and runs a first sync;
activities before `PUBLIC_BLOCK_START` are never fetched.

The plan is a separate thing from the activities, and nothing writes it for you. Either
seed the example block or author your own (section f). Seeding is one endpoint, and it is
deliberately destructive — session ids derive from week and weekday, so re-seeding is
"reset to the plan", not "merge with it":

```bash
HOST=https://your-worker-host
# `-H Origin` on BOTH, and the second is the one that surprises: Astro's CSRF check
# forbids any POST whose Origin does not match, and only exempts it when the request
# carries a *non*-form content-type. A bodyless POST carries none, so `/api/plan/seed`
# answers `403 Cross-site POST form submissions are forbidden` — before the cookie is
# so much as looked at — unless the header is there.
curl -s -c /tmp/lm.cookies -X POST "$HOST/api/login" \
  -H "Origin: $HOST" --data-urlencode "password=$APP_PASSWORD"
curl -s -b /tmp/lm.cookies -X POST "$HOST/api/plan/seed" -H "Origin: $HOST"
```

The same thing is one call on the MCP server (`seed_plan`), which needs no cookie.

### CI: Cloudflare Workers Builds

Deployment belongs to Cloudflare, not to GitHub Actions: connect the repository under
**Workers & Pages → your Worker → Settings → Build**. Those commands live in the
dashboard rather than in this repository, so they are worth writing down:

| Setting | Value |
|---|---|
| Build command | `pnpm test && pnpm build` |
| Deploy command | `npx wrangler deploy -c dist/server/wrangler.json` |
| Non-production branch | `npx wrangler versions upload -c dist/server/wrangler.json` |

A dashboard left on its default — no build command and a bare `npx wrangler deploy` — is
the one configuration where this breaks in CI while `pnpm deploy` passes on your machine,
for exactly the reason in step 4.

The other CI-only trap is pnpm. Workers Builds ships pnpm 10.11.1, which reads
`pnpm-workspace.yaml`, silently ignores the pnpm-11 `allowBuilds` key and therefore skips
`workerd`'s postinstall — and `astro build` then fails on a machine where it works
locally. `packageManager` in `package.json` is what fixes it: pnpm 10 self-installs the
pinned version and re-execs. **Do not remove it**, and note that Workers Builds has no
pnpm version file, only a `PNPM_VERSION` build variable, so the pin has to live in the
manifest.

`.github/workflows/ci.yml` in this repository runs the tests, the type check and the
build on every push and pull request. It has no deploy step and needs no secrets, by
design.

---

## d. Making it your race

### The `.env`

```bash
cp .env.example .env
```

Eleven values, all optional — with no `.env` at all the app builds the block this
repository ships with. Four of them are what the app *calls* itself; seven are the block
it computes.

**Identity** — between them these reach all eight page titles, the launch screen, the
login screen, `404`, the meta description, the Open Graph card and
`manifest.webmanifest`, which is generated from them rather than served as a static file.

| Variable | Means | Format | Default |
|---|---|---|---|
| `PUBLIC_APP_NAME` | What the app calls itself: the `<title>` of every page and the name of the installed app. Distinct from the race — the event is *La Mitja de Granollers*, the app is *La Mitja 2027*. | free text | `La Mitja 2027` |
| `PUBLIC_APP_SHORT_NAME` | The home-screen label. iOS truncates around twelve characters, so keep it short. | free text | `La Mitja` |
| `PUBLIC_APP_DESCRIPTION` | One sentence, read three times: meta description, Open Graph card, manifest. | free text, Spanish | *Entrenamiento hacia una media…* |
| `PUBLIC_GOAL_LABEL` | The objective as a runner says it — the heading on `/`. Not derived from the goal time, because naming the distance in Spanish and deciding what is being chased is a sentence, not arithmetic. | free text | `Media sub-1:20` |

**The block** — the values the training maths is computed from.

| Variable | Means | Format | Default |
|---|---|---|---|
| `PUBLIC_RACE_NAME` | The race as it is printed on the bib. Becomes the title of the final session in the seeded plan. | free text | `La Mitja de Granollers` |
| `PUBLIC_RACE_DATE` | Race day. The block ends on it and every countdown points at it. | `YYYY-MM-DD` | `2027-01-24` |
| `PUBLIC_RACE_DISTANCE_M` | Race distance, metres (Strava units). `42195` for a marathon, `10000` for a 10K. | number > 0 | `21097.5` |
| `PUBLIC_BLOCK_START` | The Monday the block opens on. Nothing before it is synced or counted. | `YYYY-MM-DD`, **must be a Monday** | `2026-08-17` |
| `PUBLIC_GOAL_TIME` | The goal finish time. Every pace band is a ratio of the pace it implies over the race distance. | `h:mm:ss` or `mm:ss` | `1:19:59` |
| `PUBLIC_HR_MAX` | Maximum heart rate, bpm. The five zone floors are shares of it; no bpm is ever rendered, only the zone. | number > 0 | `192` |
| `PUBLIC_PREV_RACE_DATE` | Last season's race — the anchor `docs/data/*.csv` is aligned on, so both seasons read at the same distance from race day. | `YYYY-MM-DD`, before the race date | `2026-01-18` |

Everything else follows. The number of weeks is `ceil((RACE_DATE − BLOCK_START) / 7 days)`;
the five phases are shares of that total, so a 19-week block still gets all five of them —
rebuild, base, threshold, race-specific, taper — in proportion; and the six pace bands are
ratios of goal pace, so moving the goal moves easy, long, steady, threshold, race and VO2
together.

Four rules are checked when the module loads, which means a bad value **fails the build**
rather than quietly producing a plan for the wrong year: the block must open on a Monday,
race day must fall after it, the block must be at least four weeks long, and last
season's race must precede this one. A blank line (`PUBLIC_HR_MAX=`) counts as absent and
falls back to the default.

These are **build-time** values. Vite compiles them into the Worker and the client bundle,
so changing one is `pnpm deploy`, not a restart. That is the honest shape for values that
differ per fork rather than per environment — a race date does not change between staging
and production, it changes between one runner and another. `src/lib/config.ts` explains
the reasoning at length.

> **One rough edge**: the unit tests do not read your `.env`. Vitest loads a `.env` only
> for variables matching its configured `envPrefix`, which defaults to `VITE_`, and
> `vitest.config.ts` does not set `envPrefix: 'PUBLIC_'` — so `pnpm test` runs against
> the defaults regardless of what you configure. Adding that line makes the tests follow
> your block; `test/unit/seed.test.ts` and the *"the block the app actually runs on"*
> block in `test/unit/config.test.ts` then fail, correctly, because their assertions
> (`TOTAL_WEEKS === 23`, the race session's title, the six pace bands) are assertions
> about the *example* block and belong with it.

### What a `.env` cannot move

Every *name* is a setting — the four identity values above reach all eight page titles,
the launch screen, the login screen, `404`, the meta description, the Open Graph card and
the manifest. What is left is the part that is genuinely writing rather than naming, plus
two files that cannot read a build-time value at all.

| Where | What is hard-coded | Why it cannot be a setting |
|---|---|---|
| `src/lib/seed.ts` | **The plan itself** — 23 hand-written weeks, all Spanish: session titles, coaching notes, the cadence and knee-protocol prose, `DOWN_WEEKS = [3, 8, 12, 15, 20]`, the four checkpoint `marker(…)` paces (absolute s/km from docs/03 §5, *not* ratios of the goal like the pace bands are), and the `startKm`/`endKm` ramp in kilometres per week. Its `focus` lines name *el Tast*, *la Behobia* and `3:47/km`. | It is a training design, not a value. Rewrite it, or skip it entirely and author your block through the MCP server (§f). |
| The whole interface | Spanish (es-ES) throughout — every label, button, empty state and error. `<html lang="es">` and every `Intl` formatter is built with `'es-ES'`. | Translating means editing strings; there is no locale switch and adding one is a real project. |
| `public/favicon.svg` + every PNG beside it | The mark is La Mitja's course profile — the climb through 10 km, then the descent that steepens to the finish. | It is a drawing. Edit the SVG and re-rasterise all of them together (`qlmanage -t -s <px> -o . favicon.svg` on macOS); they drift otherwise. |
| `public/sw.js` | The offline page's Spanish copy, and three colours written out as hex. | `public/` is copied byte-for-byte into the build, so nothing in it sees a build-time value. Its `<title>` is deliberately nameless for that reason. The colours are copies of `--color-surface`, `--color-label` and `--color-mint`; a service worker cannot import the stylesheet. Also bump its `VERSION` when you change the precached files or the caching rules, or phones keep serving the old ones. |
| `src/layouts/Base.astro`, `src/pages/manifest.webmanifest.ts` | `<meta name="theme-color">`, and `background_color` / `theme_color`. | All three are `--color-surface` written out — a `<meta>` and a JSON body cannot read a token. Change a ground and grep the hex; it has drifted before. |
| `astro.config.mjs` | `site:` — your deployed origin | Used to build the absolute Open Graph URLs at prerender time. |
| `src/components/Progress.tsx`, `src/components/TrainingLog.tsx` | The season label `2025-26`, and one `'de 21,1 km'` written out where its sibling in `Dashboard.tsx` derives it | Small, real, and worth fixing if you fork — they are the last two places a number is written rather than derived. |
| `docs/` | `01`, `02`, `03` and `docs/data/*.csv` are the author's race analysis, injury history and Strava exports | They are the reasoning behind every default above. Replace them with your own, or delete them. |

### Last season's data

`src/lib/baseline.ts` globs `docs/data/*.csv` — it does not name individual files. Two
words in a filename decide what a file is: **`post-race`** makes it the pre-block period
(in the fitness average, never compared against), and **`build`** makes it the previous
season, the one every comparison is drawn against. A file whose name carries neither is
ignored — silently, and on purpose, because this directory is also where a raw export
lands on its way to being trimmed. Several files of the same kind are concatenated in
sorted-path order, so a season may be split across exports.

The columns are named by the header row rather than by position:
`date, sport, dist (m), time (s, moving), elev (m), re (relative effort)`, plus an
optional `name` — this repository's build export carries activity names and its
post-race export does not. `date` is `YYYY-MM-DD` and no field may contain a comma;
there is no quoting.

So: drop your own Strava exports in with those columns and one of those two words in the
filename, or delete the files. With the directory empty every comparison degrades to "absent" rather than to
zero — the *vs* table and the shadow series stop rendering, best efforts read `—`, and
the fitness curve simply opens at the start of your block.

> One line does not degrade cleanly: `VolumeCard` in `src/components/Progress.tsx` still
> renders *"la temporada pasada … su bloque abre en la semana N"* when there is no
> previous season at all. It is a sentence about a season that does not exist. Deleting
> that context line when `BASELINE.length === 0` is a one-branch fix if it bothers you.

---

## e. Local development

```bash
cp .dev.vars.example .dev.vars   # the same four secrets, for the local Worker
pnpm db:migrate:local
pnpm dev
```

| Command | Does |
|---|---|
| `pnpm dev` | Astro dev server on `localhost:4321` (workerd, via the Cloudflare vite plugin) |
| `pnpm build` | `dist/client` (assets) + `dist/server` (the Worker) |
| `pnpm preview` | `wrangler dev` against the built output and the local D1 |
| `pnpm test` | vitest — pure logic only, no bindings, no D1 |
| `pnpm typecheck` | `astro check` — the full check, `.astro` templates included. It needs `@astrojs/check`, which is deliberately not a dependency here; it offers to install it on first run. |
| `pnpm typecheck:ci` | `astro sync && tsc --noEmit` — every `.ts`/`.tsx` file, with nothing to install. This is what CI runs. |
| `pnpm db:generate` | regenerate `migrations/` from `src/lib/db/schema.ts` — never hand-edit a migration |
| `pnpm db:migrate` / `db:migrate:local` | apply migrations remotely / locally |
| `pnpm cf-typegen` | regenerate `worker-configuration.d.ts` after editing `wrangler.jsonc` |
| `pnpm deploy` | build, then deploy the generated config |

The local D1 is a different database from the remote one. It starts empty: run
`db:migrate:local`, then seed a plan into it (`POST /api/plan/seed`, section c step 5,
against `localhost`). It will have no activities unless you connect Strava against
localhost, which the callback domain in section b decides.

**Do not remove `--persist-to` from the `preview` script.** Wrangler resolves local
storage relative to the config file, and `preview` points at `dist/server/wrangler.json`
— so without it the preview quietly opens a *second, empty* D1 under
`dist/server/.wrangler/` and every query fails on a missing table while
`pnpm db:migrate:local` looks like it worked. `preview` also serves the assets it saw at
startup: rebuild while it is running and every page 404s until you restart it.

Fire the nightly sync without waiting for the clock, against `pnpm preview`:

```bash
curl "http://localhost:8787/cdn-cgi/handler/scheduled?cron=0+3+*+*+*&format=json"
```

---

## f. The MCP server

The deployment is also an MCP server. It is how you write a plan without hand-typing
twenty-three weeks of sessions: an agent reads the block's dates, paces and session
vocabulary, reads what you have actually been running, and writes the weeks back.

**Endpoint** — one address, `POST` only:

```
POST https://<your-worker-host>/api/mcp
```

**Authentication** — `Authorization: Bearer <APP_PASSWORD>`, the same single password the
app signs in with, compared in constant time before the request body is even parsed.

> That token is full read/write access to the deployment: the whole training log, and the
> power to overwrite or delete the entire plan. It is the app password. Treat handing it
> to an agent as handing over the app, and rotate it (`wrangler secret put APP_PASSWORD`)
> if it leaks — which also signs every device out.

### Connect it to Claude Code

```bash
claude mcp add --transport http lamitja https://<your-worker-host>/api/mcp \
  --header "Authorization: Bearer $APP_PASSWORD"
```

Add `--scope user` to have it available in every project rather than only this one.
`claude mcp list` shows whether it connected; `claude mcp remove lamitja` undoes it.

### Check it from a terminal first

```bash
curl -sS https://<your-worker-host>/api/mcp \
  -H "Authorization: Bearer $APP_PASSWORD" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | jq '.result.tools[].name'
```

No `initialize` handshake and no `MCP-Protocol-Version` header: a versionless request is
served leniently, on purpose, because a bare `curl` is the first thing anyone points at a
server they just deployed. The brief an agent starts from is one call further:

```bash
curl -sS https://<your-worker-host>/api/mcp \
  -H "Authorization: Bearer $APP_PASSWORD" -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"get_block","arguments":{}}}'
```

`GET` and `DELETE` answer `405` with `Allow: POST` — there is no server-initiated stream
and no session to delete. A `401` means the bearer token is wrong; a `500` saying
`APP_PASSWORD is not configured` means the secret was never set on the deployment.

### The eleven tools

| Tool | Does | Key arguments |
|---|---|---|
| `get_block` | **Call first.** Race, block dates, total weeks, goal time and pace, the six pace bands with zone numbers, the session types and step vocabulary, today's date and week index. Touches no database. | — |
| `list_weeks` | Every week: Monday/Sunday, phase, focus, target volume, down-week flag, notes, what its sessions actually prescribe, and what was run. | — |
| `list_sessions` | The prescribed sessions with their structured steps, targets, and whether they are done (ticked off *or* matched to an activity). | `weekIndex` \| `from`, `to` |
| `list_activities` | What was actually run. Metres, seconds, `mm:ss` pace, cadence in spm, heart rate as a **zone** and never as bpm, training load. | `from`, `to`, `limit` |
| `get_training_summary` | The derived picture: totals, distance per week, consistency, 42/7-day fitness and fatigue, best efforts, the half-marathon time they project to, zone shares. | `from`, `to` (default: last 28 days) |
| `upsert_week` | Write one week. Absent field = leave alone, explicit `null` = clear. | `weekIndex`, `phase`, `focus`, `targetVolumeM`, `isDownWeek`, `notes` |
| `create_session` | Add one session. A client-chosen `id` makes it idempotent. | `scheduledOn`, `type`, `title`, `steps`, targets, … |
| `create_sessions` | A whole week or a whole plan in one call. Every row is validated before any is written; failures are reported by array index. | `sessions[]` |
| `update_session` | Patch by id. Does **not** drop `steps` when you change a target — pass `steps: null` yourself. | `id` + any field |
| `delete_session` | Remove one session. Does not touch the week's target volume. | `id` |
| `seed_plan` | Reset to the built-in example plan. **Overwrites** everything, including anything you wrote. | — |

Boundary types are the ones a person would write: dates `YYYY-MM-DD`, paces `mm:ss` per
kilometre, distances metres, durations seconds. Tool names and descriptions are English
because an agent reads them; a session's `title` and `notes` are read by the athlete, so
the server asks for those in Spanish.

### What to ask for

- *"Write me a 12-week 10K plan starting the Monday after next. Four runs a week, long
  run on Sunday, one strength day, nothing on Saturdays."*
- *"Move this week's long run to Sunday and rebalance the week so the volume target still
  adds up."*
- *"Look at what I actually ran the last three weeks — not what was planned — and adjust
  the next block. I missed two quality sessions and the knee complained on the hills."*
- *"Compare my current fitness and fatigue against where I was eleven weeks out last
  season, and tell me whether the ramp in weeks 9–12 is realistic."*

A good agent will call `get_block` first, then `list_weeks` and `get_training_summary`,
write the weeks with `upsert_week`, and write the sessions in one `create_sessions` call
with stable ids so running the same request twice rewrites the plan instead of
duplicating it. The server says so itself, in its `instructions`.
