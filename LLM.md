# LLM.md — setting this repository up, for an agent

**You are an agent standing this app up on someone's machine.** Read this file to the end
before you run anything, then work through it in order.

Three parts, and the middle one is a full stop:

1. **[Local](#1-local)** — install, configure, migrate, run, author a plan, verify. No Cloudflare
   account, no Strava application, nothing irreversible.
2. **[Ask](#2-stop-here-and-ask)** — when local works, stop and ask the user whether to
   deploy. Deploying creates real resources on their account and publishes a URL with
   their training data behind one password. It is not yours to decide.
3. **[Deploy](#3-deploy-to-cloudflare)** — only after they say yes.

This file is the checklist. It is not the reasoning:

| Read | When |
|---|---|
| **this file** | you are setting the project up or deploying it |
| [`AGENTS.md`](AGENTS.md) (symlinked `CLAUDE.md`) | you are about to *change* code — architecture, conventions, and nineteen platform gotchas verified not to re-derive |
| [`docs/setup.md`](docs/setup.md) | you want the long version of any step below, written for a person, with the why |

Every section here links to its section there. If the two disagree, one of them is stale —
say so rather than picking silently.

---

## What you are setting up

| | |
|---|---|
| **The app** | A training tracker for one runner and one race block. Astro 7 PWA, prerendered shells + `/api/*` routes, all on a single Cloudflare Worker. |
| **Storage** | One D1 database for athlete-owned rows, one KV namespace holding one OAuth state token, and one private R2 bucket for optimized profile avatars. |
| **Auth** | One password (`APP_PASSWORD`) exchanged for a year-long signed cookie. No accounts, no multi-tenancy. |
| **Data in** | Strava, via OAuth + webhook + a nightly cron. Nothing before the block's start date is ever fetched. |
| **Agent surface** | The same data as an MCP server on `POST /api/mcp`, bearer-authenticated with that same password. Eleven tools. |
| **Ships configured as** | *La Mitja 2027* — La Mitja de Granollers, 24 Jan 2027, sub-1:20, a 23-week block from Mon 17 Aug 2026. That is the reference instance; eleven `PUBLIC_*` values move it to another race. |

The interface is Spanish. The code, the comments and every tool description are English.
That split is deliberate — do not "fix" it in either direction.

---

## Rules for the whole run

- **pnpm, never npm or yarn.** `packageManager` pins `pnpm@11.1.2` and any pnpm 10+
  self-installs it. `pnpm-workspace.yaml` carries the `allowBuilds` entry without which
  `workerd` never unpacks its binary and `astro build` fails.
- **`wrangler` is a devDependency, not a global.** Every wrangler command in this file is
  `pnpm exec wrangler …`. A bare `wrangler` is *command not found* on a fresh clone.
- **Secrets.** `.env` and `.dev.vars` are gitignored; keep them that way and never
  `git add -f` either. A secret may be written to `.dev.vars`, piped to
  `wrangler secret put`, or shown to *this* user — nowhere else, and never to a third-party
  service. The one secret the user must see is their own `APP_PASSWORD`: they have to type
  it to sign in.
- **Never hand-edit `migrations/`.** They are generated from `src/lib/db/schema.ts` by
  `pnpm db:generate`.
- **Never run a bare `wrangler deploy`.** It reads the root config, whose `main` is the
  *source* entrypoint, and fails on Astro's virtual modules. `pnpm deploy` deploys the
  config the adapter generates. (`AGENTS.md` gotcha 6.)
- **Copy ids, never recall them.** The Cloudflare database id, KV id and Strava client id
  in this repository are the author's. Take the replacements from the command or the page
  that printed them.
- **Do not commit and do not push** unless the user asks. Configuring a fork touches
  `wrangler.jsonc`, which is tracked — leave the diff in the working tree and tell them.

---

## 0. Preflight

Read-only. Run all of it before deciding where to start.

```bash
node -v                              # ≥ 22.12 (engines in package.json)
pnpm -v                              # any 10+; the manifest pins and re-execs 11.1.2
ls -a .env .dev.vars 2>/dev/null     # what is already configured
pnpm exec wrangler whoami            # Cloudflare login — "not authenticated" is fine for part 1
git status --porcelain               # is the tree clean before you touch it
```

| What you find | Where to start |
|---|---|
| No `node_modules` | [1.1](#11-install) |
| `.dev.vars` missing or empty | [1.3](#13-devvars--the-four-secrets) |
| Everything present, app never run | [1.5](#15-run-it) |
| Local works, no Cloudflare resources yet | [2](#2-stop-here-and-ask) |
| `wrangler.jsonc` still carries the author's ids and a deploy is wanted | [3.2](#32-name-the-worker) |

If the tree is dirty, ask before editing tracked files — several sessions may be working
in this repository at once.

---

## 1. Local

Needs nothing but Node, pnpm and a terminal. Strava stays disconnected until part 3, and
that is expected — the app runs, signs in and shows a plan without it.

### 1.1 Install

```bash
pnpm install
pnpm test        # 14 files, ~290 tests, about a second — the cheapest proof the toolchain is sound
```

If `workerd` complains about a missing binary, the `packageManager` pin did not take
effect and pnpm skipped its postinstall — see [troubleshooting](#troubleshooting).

### 1.2 `.env` — which race (optional)

Skip this and the app builds the reference block. Ask the user once:

> Do you want this pointed at your own race now, or shall we run the author's block
> (La Mitja, Jan 2027) first and change it later?

Changing it later costs a rebuild, so either answer is cheap. If they want their own:

```bash
cp .env.example .env
```

Eleven values, all optional, all with defaults. Four are what the app **calls** itself;
seven are the **block** the training maths is computed from:

| | |
|---|---|
| `PUBLIC_APP_NAME`, `PUBLIC_APP_SHORT_NAME`, `PUBLIC_APP_DESCRIPTION`, `PUBLIC_GOAL_LABEL` | every page title, the launch screen, `/login`, `404`, the Open Graph card, the manifest |
| `PUBLIC_RACE_NAME`, `PUBLIC_RACE_DATE`, `PUBLIC_RACE_DISTANCE_M` | the race |
| `PUBLIC_BLOCK_START` | the Monday the block opens on — **must be a Monday** |
| `PUBLIC_GOAL_TIME` | goal finish; every pace band is a ratio of the pace it implies |
| `PUBLIC_HR_MAX` | zone floors are shares of it; measured, not 220 − age |
| `PUBLIC_PREV_RACE_DATE` | last season's race — the anchor the previous-season CSVs are aligned on (`src/lib/baseline.ts` globs them; with none, every comparison reads as absent) |

Three things to know before you write one:

- **They are compiled in.** Vite substitutes them at build time, so a change is
  `pnpm deploy` (or a dev-server restart), never a live reload of a running Worker.
- **A bad value fails the build, on purpose.** Blank counts as absent; the block must open
  on a Monday, run at least four weeks, and end after it starts.
- **`pnpm test` does not read `.env`.** Vitest's `envPrefix` defaults to `VITE_` and
  `vitest.config.ts` does not override it, so the suite always runs against the defaults.
  That is a known rough edge, documented in `docs/setup.md` §d — do not "fix" it as part
  of setup, because one test deliberately asserts the example block.

The number of weeks and the six pace bands follow from those values. Everything a `.env`
*cannot* move — the Spanish copy, the icons — is listed file by file in
[`docs/setup.md` §d](docs/setup.md#d-making-it-your-race).

### 1.3 `.dev.vars` — the four secrets

Required: without `APP_PASSWORD` the app cannot sign anyone in. `.dev.vars` is the local
half of `wrangler secret put`, and it is gitignored.

`.dev.vars.example` documents all four. Generate them rather than inventing them, and
write the file without echoing three of the four into the transcript:

```bash
APP_PW=$(openssl rand -base64 24)
cat > .dev.vars <<'EOF_HEAD'
# Local secrets. Gitignored. The deployed Worker gets the same four via wrangler secret put.
EOF_HEAD
{
  printf 'APP_PASSWORD="%s"\n' "$APP_PW"
  printf 'STRAVA_CLIENT_SECRET=""\n'
  printf 'STRAVA_WEBHOOK_VERIFY="%s"\n' "$(openssl rand -hex 16)"
  printf 'TOKEN_ENC_KEY="%s"\n' "$(openssl rand -base64 32)"
} >> .dev.vars

echo "Local sign-in password: $APP_PW"     # the one the user needs to see
```

| Secret | Notes |
|---|---|
| `APP_PASSWORD` | The login, shared across the user's devices. Long and random: the URL is public and the source explains the door. Rotating it signs every device out. |
| `STRAVA_CLIENT_SECRET` | Leave empty locally. It only matters once there is a Strava application ([3.4](#34-the-strava-application-the-user-in-a-browser)); nothing but Strava calls fail without it. |
| `STRAVA_WEBHOOK_VERIFY` | Any random string. Echoed once, at subscription time. |
| `TOKEN_ENC_KEY` | AES-GCM key for the Strava refresh token at rest. Must decode to **exactly 32 bytes** — `openssl rand -base64 32`. Treat it as permanent on a live deployment: rotate it and the stored token stops decrypting, and Strava must be reconnected. |

### 1.4 Create the local database

```bash
pnpm db:migrate:local
```

Four tables into `.wrangler/state`. That is the same store `pnpm dev` reads — the
Cloudflare vite plugin defaults its persist directory to `.wrangler/state` and loads
`.dev.vars` — so a migration applied here is visible to the dev server with no further
wiring. The remote D1 is a different database with a different token in it; nothing in
part 1 touches it.

Verify:

```bash
pnpm exec wrangler d1 execute DB --local \
  --command "select name from sqlite_master where type='table' order by name"
# → activities, app_state, d1_migrations, plan_sessions, plan_weeks
```

### 1.5 Run it

```bash
pnpm dev        # http://localhost:4321 — run it in the background, keep the log
```

Verify, and read both numbers:

```bash
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:4321/login      # 200
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:4321/api/data   # 401
```

The `401` is the app working, not failing: `src/middleware.ts` gates `/api/*` closed by
default and nothing has signed in yet. A `500` on `/login` is usually a stale Vite
dependency cache — see [troubleshooting](#troubleshooting).

### 1.6 Put a plan in the database

An empty database renders an empty app. There is no built-in plan to seed: every athlete
authors their own block through the MCP server (or by hand in `/plan`). Mint a token in
`/ajustes`, then drive `POST /api/mcp` — `get_block` first, `upsert_week` for the weeks,
`create_sessions` for the sessions, stable ids (`w03-tue-1`) so re-running rewrites
instead of duplicating. Works over plain `http` on localhost:

```bash
curl -s http://localhost:4321/api/mcp \
  -H "Authorization: Bearer $MCP_TOKEN" -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"get_block","arguments":{}}}'
```

Verify:

```bash
pnpm exec wrangler d1 execute DB --local \
  --command "select (select count(*) from plan_weeks) as weeks, (select count(*) from plan_sessions) as sessions"
# → 23 weeks and ~180 sessions, for the reference block
```

### 1.7 Check what CI checks

```bash
pnpm test           # vitest, pure logic, no bindings
pnpm typecheck:ci   # astro sync && tsc --noEmit — no extra install
pnpm build          # dist/client + dist/server
```

`pnpm typecheck` (`astro check`) also covers `.astro` templates but wants
`@astrojs/check`, which is deliberately not a dependency; it offers to install it.

### Done when

- [ ] `/login` answers 200 and the password signs in from a browser
- [ ] `/plan` shows weeks and sessions
- [ ] `pnpm test`, `pnpm typecheck:ci` and `pnpm build` all pass

Tell the user: the URL, their password, and that Strava is not connected yet.

### What cannot work locally, and why

| | |
|---|---|
| **Strava OAuth** | The authorization callback domain is a single app-wide field on the Strava application, so it names one host. Point it at a deployed Worker and `localhost` cannot complete the flow; point it at `localhost` and the deployment cannot. (`AGENTS.md` gotcha 8.) That is why deploying comes before developing here. |
| **The webhook** | Strava's servers have to reach the callback, so it needs a public URL. |
| **Activities** | None, until Strava is connected. Every screen is built to read as empty rather than as zero. |
| **Rate limits** | The binding is simulated locally and `src/lib/ratelimit.ts` fails open when it is absent, so nothing throttles you here. |
| **`pnpm preview`** | Runs `wrangler dev` against `dist/`. It needs the `--persist-to` already in the script (without it wrangler opens a *second, empty* D1) and it serves the assets it saw at startup — rebuild while it runs and every page 404s until you restart it. |

---

## 2. Stop here and ask

Do not deploy on your own initiative. Report what runs and ask, in the user's language,
something close to:

> Local setup works — `http://localhost:4321`, signed in with the password above, plan
> written, tests passing. Want to deploy it to Cloudflare now?
>
> It creates a Worker, a D1 database and a KV namespace on your account (the free plan
> covers all of it at this size), publishes a `*.workers.dev` URL, and needs you at a
> browser twice: once to approve `wrangler login`, once to create your own Strava API
> application.

Offer three answers: **deploy now**, **stay local for now**, **later — tell me what it
will need**. If it is not "deploy now", stop: summarise what is running and point back at
this file. Do not create Cloudflare resources to "be ready".

Before starting part 3, confirm they have a Cloudflare account and a Strava account, and
are at a machine with a browser.

---

## 3. Deploy to Cloudflare

Order matters, and it is not the obvious one: the Worker's **name** decides its URL, the
URL is what the Strava application's callback domain must equal, and Strava's field is
app-wide. So name the Worker, create the Strava application against that name, and deploy
once — rather than deploying, discovering the host and deploying again.

Long version with every reason spelled out: [`docs/setup.md`](docs/setup.md) §b and §c.

### 3.1 Log in to Cloudflare — first, and it is the user's to do

```bash
pnpm exec wrangler login
```

This opens a browser and waits for consent. **Do not run it in the background and do not
try to answer it yourself.** In Claude Code, hand it over: ask the user to type

```
! pnpm exec wrangler login
```

so the output lands in the conversation. On a headless machine the alternative is a
`CLOUDFLARE_API_TOKEN` in the environment, scoped to *Workers Scripts: Edit*, *D1: Edit*
and *Workers KV Storage: Edit*.

Verify, and read the account name back to the user — an account with more than one is the
easiest way to create resources in the wrong place:

```bash
pnpm exec wrangler whoami
```

### 3.2 Name the Worker

Edit `name` in `wrangler.jsonc`. The deployed address becomes
`https://<name>.<your-subdomain>.workers.dev`, and everything below refers to it as
`$HOST`. Also update `site:` in `astro.config.mjs` — it is what builds the absolute Open
Graph URL at prerender time.

### 3.3 Create the database, KV namespace and avatar bucket

```bash
pnpm exec wrangler d1 create <your-db-name>
pnpm exec wrangler kv namespace create CACHE
pnpm exec wrangler r2 bucket create <your-worker-name>-avatars
```

Each prints a config block. Copy into `wrangler.jsonc`, replacing the author's values:

- `d1_databases[0].database_name` **and** `database_id`
- `kv_namespaces[0].id`
- `r2_buckets[0].bucket_name` (keep the binding named `AVATARS` and the bucket private)

Those ids are not secret and not reusable — against another account they resolve to
nothing and the deploy fails on a missing binding. Name the database anything: the `db:*`
scripts address it by its binding (`DB`), which wrangler accepts wherever it takes a name.

Then regenerate the binding types:

```bash
pnpm cf-typegen
```

### 3.4 The Strava application (the user, in a browser)

<https://www.strava.com/settings/api> → create one. The field that costs afternoons:

| Field | Value |
|---|---|
| **Authorization Callback Domain** | the **bare host** from 3.2 — `my-worker.my-name.workers.dev`. No `https://`, no path. |
| Website | anything |
| Category | Training |

Strava checks that domain *before* rendering the consent screen, so a mismatch is an
opaque `400` on `/oauth/authorize` that never reaches a page able to explain itself.

Then, from the application page:

- **Client ID** — public. Put it in `wrangler.jsonc` under `vars.STRAVA_CLIENT_ID`.
- **Client Secret** — secret. It goes in the next step (and into `.dev.vars` if the user
  wants Strava working locally too).

The app requests `read,activity:read_all`, and `activity:read_all` is not optional: without
it Strava silently omits private activities and every volume total is quietly wrong. The
callback rejects a grant that comes back without it.

### 3.5 The four secrets

Put the Strava client secret from 3.4 into `.dev.vars` first, then send all four up.
`wrangler secret put` reads standard input, so none of this has to go through a prompt:

```bash
set -a; . ./.dev.vars; set +a   # `KEY="value"` lines are valid shell, so this just works

printf '%s' "$APP_PASSWORD"          | pnpm exec wrangler secret put APP_PASSWORD
printf '%s' "$STRAVA_CLIENT_SECRET"  | pnpm exec wrangler secret put STRAVA_CLIENT_SECRET
printf '%s' "$STRAVA_WEBHOOK_VERIFY" | pnpm exec wrangler secret put STRAVA_WEBHOOK_VERIFY
printf '%s' "$TOKEN_ENC_KEY"         | pnpm exec wrangler secret put TOKEN_ENC_KEY
```

The deployment's secrets and `.dev.vars` are independent stores and nothing forces them to
match — but matching is worth it twice over: the same password signs both in, and
[3.8](#38-the-webhook-optional) needs the *same* `STRAVA_WEBHOOK_VERIFY` string the Worker
holds. Generate a fresh value straight into `wrangler secret put` and it is gone before you
can subscribe the webhook with it.

If wrangler says there is no Worker by that name yet, let it create one: the deploy
replaces it and the secrets survive.

```bash
pnpm exec wrangler secret list      # four names, no values
```

### 3.6 Migrate, then deploy

```bash
pnpm db:migrate     # wrangler d1 migrations apply DB --remote
pnpm deploy         # astro build && wrangler deploy -c dist/server/wrangler.json
```

**Never a bare `wrangler deploy`.** It reads the root config, whose `main` is the source
entrypoint; wrangler's esbuild cannot resolve Astro's virtual modules and the deploy fails
outright — and past that it resolves the assets directory wrongly.

If `wrangler d1 migrations apply --remote` fails on the upload step, retry: it is flaky on
transient network errors, not on your schema.

### 3.7 Sign in, connect Strava, author the plan

1. Open `$HOST`. It lands on `/login`; the password is `APP_PASSWORD`, exchanged for a
   cookie good for a year on every device it is typed on.
2. Press **Conectar con Strava** on the home screen and accept the consent screen **with
   the private-activities box ticked**. The callback stores the encrypted refresh token and
   runs a first sync. Nothing before `PUBLIC_BLOCK_START` is fetched, ever.
3. Author the plan, exactly as in [1.6](#16-put-a-plan-in-the-database) but against
   `$HOST` — mint the MCP token in `/ajustes` and write the block through
   `POST $HOST/api/mcp`.

### 3.8 The webhook (optional)

Without it the app is up to a day behind: `wrangler.jsonc` schedules a nightly cron at
03:00 UTC that runs the same sync. With it, a run appears seconds after the watch uploads.

The secret must already be deployed — Strava validates the callback synchronously, within
about two seconds, and a Worker that does not know the verify token answers `403` and the
subscription is refused.

```bash
curl -X POST https://www.strava.com/api/v3/push_subscriptions \
  -F client_id=YOUR_CLIENT_ID \
  -F client_secret=YOUR_CLIENT_SECRET \
  -F callback_url=$HOST/api/strava/webhook \
  -F verify_token=YOUR_STRAVA_WEBHOOK_VERIFY
# → {"id": 123456}
```

An application may hold only one subscription; `GET` the same URL to see it and `DELETE
/push_subscriptions/<id>?client_id=…&client_secret=…` to remove it.

### 3.9 Continuous deployment (optional)

Deployment belongs to Cloudflare Workers Builds, not GitHub Actions — the repository's own
`.github/workflows/ci.yml` runs tests, types and a build, and has no deploy step and no
secrets by design. Connect the repository under **Workers & Pages → your Worker →
Settings → Build** and set:

| Setting | Value |
|---|---|
| Build command | `pnpm test && pnpm build` |
| Deploy command | `npx wrangler deploy -c dist/server/wrangler.json` |
| Non-production branch | `npx wrangler versions upload -c dist/server/wrangler.json` |

A dashboard left on its default — no build command and a bare `npx wrangler deploy` — is
the one configuration that breaks in CI while `pnpm deploy` passes locally.

---

## 4. Verify the deployment

```bash
HOST=https://<name>.<subdomain>.workers.dev
```

| Check | Expected |
|---|---|
| `curl -s -o /dev/null -w '%{http_code}\n' $HOST/login` | `200` |
| `curl -s -o /dev/null -w '%{http_code}\n' $HOST/api/data` | `401` — the gate is closed, as designed |
| `curl -s -o /dev/null -w '%{http_code}\n' $HOST/plan` | `200`, **not** `307` (trailing-slash handling) |
| `curl -s -o /dev/null -w '%{http_code}\n' -X GET $HOST/api/mcp` | `405` with `Allow: POST` |
| `curl -s $HOST/api/mcp -H "Authorization: Bearer $APP_PASSWORD" -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'` | ten tool names |
| `pnpm exec wrangler d1 execute DB --remote --command "select count(*) from plan_sessions"` | the number of authored sessions |
| `pnpm exec wrangler d1 execute DB --remote --command "select count(*) from activities"` | > 0 once Strava has synced |
| `curl -s $HOST/manifest.webmanifest` | JSON carrying the user's `PUBLIC_APP_NAME` |

Then open `$HOST` on a phone and add it to the home screen — the manifest, the icons and
the offline layer are the parts nothing above proves.

---

## 5. Hand back

Tell the user, in one message:

- the URL, and that the password is what signs in on every device;
- what is connected (Strava? webhook? cron is always on) and what is not;
- that `.env` and `wrangler.jsonc` changed in the working tree and are uncommitted;
- that rotating `APP_PASSWORD` signs every device out, and that `TOKEN_ENC_KEY` must not
  be rotated casually — the stored Strava token stops decrypting and has to be reconnected.

And offer the agent surface, which is the point of the MCP server — writing twenty-three
weeks of sessions is the one thing this app is bad at:

```bash
claude mcp add --transport http lamitja $HOST/api/mcp \
  --header "Authorization: Bearer $APP_PASSWORD"
```

That bearer token is the app password: full read/write over the training log and the power
to overwrite the whole plan. Say so when you hand it over. Tools and example prompts:
[`docs/setup.md` §f](docs/setup.md#f-the-mcp-server).

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `wrangler: command not found` | It is a devDependency | `pnpm exec wrangler …` |
| Dev server 500s: *"The file does not exist at …/node_modules/.vite/deps_ssr/… optimize deps directory"* | Stale Vite dependency cache in a long-running dev server | Restart `pnpm dev`; if it persists, `rm -rf node_modules/.vite` first |
| `403 Cross-site POST form submissions are forbidden` | Astro's CSRF check: a POST with no form content-type and no matching `Origin` | Add `-H "Origin: $HOST"` |
| `401 {"error":"Sin iniciar sesión"}` | No session cookie | Sign in first, or use `/api/mcp` with the bearer header |
| `500 APP_PASSWORD is not configured` from `/api/mcp` | Secret never set on the deployment | `wrangler secret put APP_PASSWORD`, then redeploy is not needed — secrets take effect immediately |
| `no such table: plan_weeks` | Migrations applied to a different local store than the server is reading | `pnpm db:migrate:local`; for `pnpm preview` keep `--persist-to .wrangler/state` in the script |
| Deploy fails on `virtual:astro:app` / `astro:assets` | A bare `wrangler deploy` | `pnpm deploy` |
| Strava `400` before the consent screen renders | Callback domain ≠ the host you are on | Fix the bare host at strava.com/settings/api ([3.4](#34-the-strava-application-the-user-in-a-browser)) |
| Redirected to `/?strava=scope` | The private-activities box was unticked | Reconnect and leave `activity:read_all` ticked |
| Sync stops working after rotating a secret | `TOKEN_ENC_KEY` changed, so the stored refresh token no longer decrypts | Reconnect Strava from `/` |
| Every page 404s under `pnpm preview` | It serves the assets it saw at startup | Restart it after a build |
| `/plan` answers `307` | `assets.html_handling` is not `drop-trailing-slash` | Restore the key in `wrangler.jsonc` |
| `workerd` has no binary; `astro build` fails | pnpm 10 ignored the pnpm-11 `allowBuilds` key | Keep `packageManager` in `package.json`; `pnpm approve-builds --all` locally |
| Tests fail after editing `.env` | They do not read it — and two of them assert the *example* block | Expected; see [1.2](#12-env--which-race-optional) |
| Home-screen name is wrong after a change | `PUBLIC_*` values are compiled in | Rebuild and redeploy |

Nineteen platform gotchas, each verified and each expensive to re-derive, are listed in
`AGENTS.md` — read them before concluding that something here is broken.

---

## Never

- Deploy, create Cloudflare resources, or subscribe a webhook before the user said yes.
- Run a bare `wrangler deploy`.
- Hand-edit anything in `migrations/`.
- Commit `.env`, `.dev.vars`, or any secret; or print one anywhere but to this user.
- Reuse the ids and the Strava client id already in the repository — they are the author's.
- Add a dependency to "fix" something the repository deliberately hand-rolled: the charts,
  the service worker and the MCP transport are all written out on purpose, and `AGENTS.md`
  says why.
- Translate the interface, author training weeks the user did not ask for, or add or
  remove the previous-season CSVs as part of setup. Those are a fork's own decisions, listed in `docs/setup.md` §d.
