# StrideAI

A training tracker for one runner and one race block. Activities sync from Strava, the
plan is written by hand, and everything else — whether a session was completed, weekly
volume against target, this season against the last one, the finish time the current
shape projects to — is derived on read. An Astro PWA on a single Cloudflare Worker with
D1 behind it, deployed with one command. It installs to the home screen and opens with
no signal — a plan is read at the trailhead, which is exactly where the bars run out.

It is built for a single athlete self-hosting their own copy: one password, one Strava
connection, one training block, no accounts and no multi-tenancy. That constraint is the
design rather than a gap — a block is ~150 activities, which is why there is no sync
queue, no cursor and no pagination anywhere in the codebase.

The block it ships with is the author's — *La Mitja 2027*: La Mitja de Granollers,
24 January 2027, sub-1:20. That is the reference instance, not the product. Fork it, point
it at your own Strava API application, name it after your own race, and the paces, the
phases and the length of the block all follow.

## Deploy it on Cloudflare

```bash
pnpm install
wrangler d1 create my-training       # paste name + database_id into wrangler.jsonc
wrangler kv namespace create CACHE   # paste id into wrangler.jsonc
wrangler secret put APP_PASSWORD     # and STRAVA_CLIENT_SECRET, TOKEN_ENC_KEY, STRAVA_WEBHOOK_VERIFY
pnpm db:migrate
pnpm deploy
```

Open the URL wrangler prints, sign in with `APP_PASSWORD`, press **Conectar con Strava**.
Creating the Strava API application, pointing its callback domain at that URL and
subscribing the webhook all need a browser — [`docs/setup.md`](docs/setup.md) walks
through it in the order it has to happen, starting with Strava, because the callback
domain is app-wide and OAuth cannot complete against localhost.

## Make it your race

```bash
cp .env.example .env      # seven values: the race, the block's Monday, the goal, HR max
```

The pace bands, the phase boundaries and the length of the block are all derived from
those. They are build-time values, so a change is a `pnpm deploy`, not a restart. What a
`.env` cannot move — the Spanish interface copy, the icons, and the 23 weeks of sessions
in `src/lib/seed.ts` — is listed file by file in
[`docs/setup.md`](docs/setup.md#d-making-it-your-race).

## Write your own plan with an agent

The deployment serves its own plan as an MCP server at `POST /api/mcp`, authenticated
with the same `APP_PASSWORD`:

```bash
claude mcp add --transport http lamitja https://<your-worker-host>/api/mcp \
  --header "Authorization: Bearer $APP_PASSWORD"
```

Then ask for the block you want: *"look at what I actually ran the last three weeks and
write the next four, long run on Sunday, no quality on consecutive days."* Eleven tools —
the block brief, what is planned, what was run, what it adds up to, and the writes — in
[`docs/setup.md`](docs/setup.md#f-the-mcp-server).

## Where things are

| | |
|---|---|
| [`AGENTS.md`](AGENTS.md) | The architecture. Every decision and why, plus the platform gotchas not to re-derive. Symlinked as `CLAUDE.md`. |
| [`docs/setup.md`](docs/setup.md) | Strava application, Cloudflare deploy, configuration, local development, the MCP server. |
| [`docs/03-training-plan-2027.md`](docs/03-training-plan-2027.md) | The plan `src/lib/seed.ts` encodes: phases, volumes, paces, checkpoints, knee protocol. |

Everything under `docs/` and `docs/data/` is the author's own race history, injury notes
and training design. A fork replaces it with its own — or deletes `docs/data/*.csv`, and
the comparison against last season simply reads as absent.

MIT — see [`LICENSE`](LICENSE).
