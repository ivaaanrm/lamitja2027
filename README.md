# StrideAI

A training tracker for a running club of one, or of a few. Activities sync from Strava,
the plan is written by hand, and everything else — whether a session was completed, weekly
volume against target, this season against the last one, the finish time the current shape
projects to — is derived on read. An Astro PWA on a single Cloudflare Worker with D1 behind
it, deployed with one command. It installs to the home screen and opens with no signal — a
plan is read at the trailhead, which is exactly where the bars run out.

**Invite-only, and small on purpose.** You deploy it, you connect it to your own Strava API
application, and you invite whoever you actually train with. Each athlete gets their own
login, their own Strava connection, their own race and dates, and their own plan; nobody
can see anybody else's. There is no public sign-up, no password reset and no billing — a
block is ~150 activities, which is why there is no sync queue, no cursor and no pagination
anywhere in the codebase either.

The block it ships with is the author's — *La Mitja 2027*: La Mitja de Granollers,
24 January 2027, sub-1:20. That is the reference instance, not the product. Fork it, point
it at your own Strava API application, name it after your own race, and the paces, the
phases and the length of the block all follow.

**Setting it up with an agent?** Hand it [`LLM.md`](LLM.md) — everything below as a
runbook, local first, with a deliberate stop to ask you before anything is created on your
Cloudflare account.

## Run it locally

```bash
pnpm install
cp .dev.vars.example .dev.vars   # five secrets — see docs/setup.md
pnpm db:migrate:local            # the eight tables, into .wrangler/state
pnpm dev                         # http://localhost:4321
```

That is the whole local loop. Strava stays disconnected until there is a deployed URL to
point its callback domain at — the app signs in, takes a plan and runs without it.

## Deploy it on Cloudflare

Set `name` in `wrangler.jsonc` first: it is the Worker's address, and it is what Strava's
app-wide callback domain has to match.

```bash
pnpm install
pnpm exec wrangler login                      # wrangler is a devDependency, not a global
pnpm exec wrangler whoami                     # which account you just signed in to
pnpm exec wrangler d1 create my-training      # paste database_name + database_id into wrangler.jsonc
pnpm exec wrangler kv namespace create CACHE  # paste id into wrangler.jsonc
pnpm cf-typegen                               # regenerate the binding types you just changed
pnpm exec wrangler secret put APP_PASSWORD    # + SESSION_SECRET, STRAVA_CLIENT_SECRET, TOKEN_ENC_KEY, STRAVA_WEBHOOK_VERIFY
pnpm db:migrate
pnpm deploy
```

Claim the owner account with `POST /api/bootstrap` (that is all `APP_PASSWORD` is for), sign
in with the email and password you chose, then press **Conectar con Strava**.
Creating the Strava API application, pointing its callback domain at that URL and
subscribing the webhook all need a browser — [`docs/setup.md`](docs/setup.md) walks
through it in the order it has to happen, starting with Strava, because the callback
domain is app-wide and OAuth cannot complete against localhost.

## Make it your deployment

```bash
cp .env.example .env      # the names, and the default block a new athlete's form opens on
```

The pace bands, the phase boundaries and the length of the block are all derived from
those. They are build-time values, so a change is a `pnpm deploy`, not a restart. What a
`.env` cannot move — the Spanish interface copy, the icons, and the 23 weeks of sessions
in `src/lib/seed.ts` — is listed file by file in
[`docs/setup.md`](docs/setup.md#d-making-it-your-race).

## Write your own plan with an agent

The deployment serves its own plan as an MCP server at `POST /api/mcp`, authenticated
with a token you mint on `/ajustes` — one per athlete, not your password:

```bash
claude mcp add --transport http lamitja https://<your-worker-host>/api/mcp \
  --header "Authorization: Bearer $MCP_TOKEN"
```

Then ask for the block you want: *"look at what I actually ran the last three weeks and
write the next four, long run on Sunday, no quality on consecutive days."* Eleven tools —
the block brief, what is planned, what was run, what it adds up to, and the writes — in
[`docs/setup.md`](docs/setup.md#f-the-mcp-server).

## Where things are

| | |
|---|---|
| [`LLM.md`](LLM.md) | The setup runbook, written for an agent: local first, then a gate, then the deploy. |
| [`AGENTS.md`](AGENTS.md) | The architecture. Every decision and why, plus the platform gotchas not to re-derive. Symlinked as `CLAUDE.md`. |
| [`docs/setup.md`](docs/setup.md) | Strava application, Cloudflare deploy, configuration, local development, the MCP server. |
| [`docs/03-training-plan-2027.md`](docs/03-training-plan-2027.md) | The plan `src/lib/seed.ts` encodes: phases, volumes, paces, checkpoints, knee protocol. |

The author's own race history, injury notes and training design live in `docs/personal/`,
which is gitignored and is not in this repository. Drop your own Strava exports into
`docs/personal/data/` to get the comparison against last season; with none, it reads as
absent, which is the normal state for anyone who clones this.

MIT — see [`LICENSE`](LICENSE).
