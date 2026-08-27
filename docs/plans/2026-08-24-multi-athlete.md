# Multi-athlete — design spec

Turns the single-athlete app into a small multi-tenant one: several athletes, each with
their own login, their own Strava connection, their own block dates and their own plan.
Invite-only: accounts exist because an admin minted a single-use link.

This file is the contract every implementation agent works from. Where it gives a
signature, use that signature exactly — several agents build against it in parallel.

Scope stays small on purpose: a handful of friends, not a product. No teams, no roles
beyond `is_admin`, no password reset by email (the admin re-invites), no per-user rate
limiting, no background queues.

---

## 1. Data model

`src/lib/db/schema.ts` is the source of truth. Four tables become eight.

```ts
export const users = sqliteTable('users', {
  id: text('id').primaryKey(),                       // uuid
  email: text('email').notNull().unique(),           // stored lowercased+trimmed
  passwordHash: text('password_hash').notNull(),     // base64 PBKDF2-SHA256 derived key
  passwordSalt: text('password_salt').notNull(),     // base64, 16 bytes
  displayName: text('display_name').notNull(),
  isAdmin: integer('is_admin', { mode: 'boolean' }).notNull().default(false),
  /** Per-athlete max HR; the five zones are shares of it. Null → DEFAULT_HR_MAX. */
  hrMax: integer('hr_max'),
  /** Which frozen CSV season this athlete may compare against. Only the owner has one. */
  baselineKey: text('baseline_key'),
  createdAt: integer('created_at').notNull().default(now),
})

export const invites = sqliteTable('invites', {
  /** SHA-256 hex of the token. The token itself is shown once and never stored. */
  tokenHash: text('token_hash').primaryKey(),
  createdBy: text('created_by').notNull().references(() => users.id, { onDelete: 'cascade' }),
  note: text('note'),                                // "para Marc", free text
  expiresAt: integer('expires_at').notNull(),
  usedAt: integer('used_at'),
  usedBy: text('used_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: integer('created_at').notNull().default(now),
})

/** One active block per athlete — the dates every week index and every metric counts from. */
export const blocks = sqliteTable('blocks', {
  userId: text('user_id').primaryKey().references(() => users.id, { onDelete: 'cascade' }),
  startsOn: integer('starts_on').notNull(),          // Monday 00:00, epoch ms
  raceOn: integer('race_on').notNull(),
  goalTimeS: integer('goal_time_s').notNull(),
  raceDistanceM: real('race_distance_m').notNull(),
  raceName: text('race_name').notNull(),
  updatedAt: integer('updated_at').notNull().default(now),
})

/** Replaces app_state. One row per athlete who connected Strava. */
export const stravaAccounts = sqliteTable('strava_accounts', {
  userId: text('user_id').primaryKey().references(() => users.id, { onDelete: 'cascade' }),
  /** Unique — this is how a webhook's `owner_id` finds its athlete. */
  athleteId: integer('athlete_id').notNull().unique(),
  athlete: text('athlete', { mode: 'json' }).$type<StravaAthlete>(),
  refreshToken: text('refresh_token').notNull(),     // AES-GCM ciphertext, as today
  lastSyncAt: integer('last_sync_at'),
  updatedAt: integer('updated_at').notNull().default(now),
})
```

`app_state` is dropped: both of its values are per-athlete now and live above.

The three existing tables gain an owner:

- `activities`: `userId text not null references users(id) on delete cascade`, index
  `(user_id, started_on)`. `id` stays the primary key — Strava ids are globally unique.
- `plan_weeks`: `userId` added, primary key becomes `primaryKey({ columns: [userId, weekIndex] })`.
- `plan_sessions`: `userId` added, primary key becomes `primaryKey({ columns: [userId, id] })`
  — session ids are `w03-tue-1` slugs and collide across athletes. Index `(user_id, scheduled_on, day_order)`.

Every read and every write filters on `userId`. There is no query in the app that may
return another athlete's row; treat a missing filter as a bug of the same class as a
missing auth check.

### Migration

`migrations/0004_multi_athlete.sql`. Procedure — the one documented exception to "never
hand-edit migrations":

1. Edit `schema.ts`, run `pnpm db:generate` so drizzle writes the file *and* its
   `meta/0004_snapshot.json` + journal entry.
2. Replace the body of the generated `.sql` with a data-preserving version; keep the
   filename and the meta files exactly as generated.

The hand-written body must, in order:

```sql
-- 1. new tables (users, invites, blocks, strava_accounts)
-- 2. the owner row, id 'owner', is_admin 1, baseline_key 'ivan-2025-26',
--    password_hash '' and password_salt '' — the empty hash is the "not bootstrapped yet"
--    marker POST /api/bootstrap looks for, and no password can hash to empty.
-- 3. the owner's block row, from the constants in block.ts
--    (starts_on 1755388800000, race_on 1769212800000, goal_time_s 4799,
--     race_distance_m 21097.5, race_name 'La Mitja')
-- 4. strava_accounts from app_state: the ciphertext in 'strava.refresh_token', the json
--    in 'strava.athlete' (athlete_id read out of it), last_sync_at from 'sync.last_at'.
--    Guard with a WHERE EXISTS so the migration also runs on an empty database.
-- 5. rebuild activities / plan_weeks / plan_sessions with the new column and PK:
--    create __new_x, INSERT ... SELECT ..., 'owner' FROM x, drop x, rename.
--    Wrap in PRAGMA foreign_keys=OFF / ON as drizzle does.
-- 6. drop app_state
```

Verify with `pnpm db:migrate:local` against a database that already has rows.

---

## 2. Auth

`APP_PASSWORD` stops being the login. It becomes the bootstrap secret, used once.

### Passwords — `src/lib/password.ts` (new)

PBKDF2-SHA256, the only KDF WebCrypto gives a Worker. No bcrypt/argon2 (WASM, not worth it).

```ts
export const PBKDF2_ITERATIONS = 210_000        // OWASP 2023 for PBKDF2-HMAC-SHA256
export async function hashPassword(password: string): Promise<{ hash: string; salt: string }>
export async function verifyPassword(password: string, hash: string, salt: string): Promise<boolean>
```

16-byte random salt, 32-byte derived key, both base64. `verifyPassword` compares with
`timingSafeEqual` from `crypto.ts` and returns `false` for an empty stored hash.
Minimum password length 10, enforced by the zod schemas, not here.

### Sessions — `src/lib/auth.ts` (rewritten)

New secret `SESSION_SECRET` (base64, 32 bytes). Do not sign with `APP_PASSWORD` any more.

```ts
export interface SessionUser { id: string; isAdmin: boolean; displayName: string; email: string; hrMax: number | null; baselineKey: string | null }

/** `userId.issuedAt.hmac` — the mac covers `userId.issuedAt`. */
export async function createSessionCookie(userId: string): Promise<string>
export const clearSessionCookie: () => string
/** Verifies the signature only — no database read. Null when absent or forged. */
export async function sessionUserId(request: Request): Promise<string | null>
```

Cookie name `lm_session`, `Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=31536000`.
Rotating `SESSION_SECRET` signs everyone out; that is the panic button.

### Users — `src/lib/users.ts` (new)

```ts
export async function findByEmail(db: Database, email: string): Promise<User | null>
export async function findById(db: Database, id: string): Promise<User | null>
export async function createUser(db: Database, input: { email: string; password: string; displayName: string; isAdmin?: boolean }): Promise<User>
export const toSessionUser = (user: User): SessionUser
export async function userCount(db: Database): Promise<number>
```

Emails are normalised (`trim().toLowerCase()`) on write *and* on lookup.

### Invites — `src/lib/invites.ts` (new)

```ts
export const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000
export async function createInvite(db: Database, createdBy: string, note: string | null, now: number): Promise<{ token: string; expiresAt: number }>
/** Consumes it: single-use, atomic — the UPDATE ... WHERE used_at IS NULL is the lock. */
export async function claimInvite(db: Database, token: string, userId: string, now: number): Promise<boolean>
export async function listInvites(db: Database): Promise<Invite[]>
export const inviteUrl = (origin: string, token: string) => `${origin}/alta?token=${token}`
```

`token` is `randomToken(24)`; only `sha256Hex(token)` is stored, so a database dump does
not hand over working invite links. Add `sha256Hex` to `crypto.ts`.

### Middleware — `src/middleware.ts`

```ts
// src/env.d.ts
declare namespace App {
  interface Locals { cfContext?: ExecutionContext; user?: import('./lib/auth').SessionUser }
}
```

Gate `/api/*` as today, plus: resolve the signed cookie to a `SessionUser` by reading the
`users` row once and putting it on `context.locals.user`. A cookie whose user no longer
exists is treated as signed out (this is how deleting a user revokes their devices).

Public API paths: `/api/login` (POST/DELETE), `/api/register`, `/api/bootstrap`,
`/api/strava/webhook`, `/api/strava/callback`.

Admin-only paths: `/api/invites`. Return 403 `{ error: 'No autorizado' }`.

Page routes stay prerendered and ungated — they hold no data; the islands redirect to
`/login` on the first 401, exactly as they do today.

### Bootstrap

`POST /api/bootstrap` `{ password: APP_PASSWORD, email, newPassword, displayName }`.
Succeeds only while the owner row still has an empty `password_hash`; sets that row's
hash and returns a session cookie. Any later call 409s. This is how the existing single
athlete gets an account without a script.

---

## 3. The block becomes a value, not a constant

`src/lib/block.ts` keeps `DAY_MS`, `WEEK_MS`, `startOfDay`, `startOfWeek`,
`HALF_MARATHON_M` unchanged and replaces the four block constants with:

```ts
export interface BlockConfig {
  /** Monday 00:00, epoch ms as local wall clock. */
  startsOn: number
  raceOn: number
  goalTimeS: number
  raceDistanceM: number
  raceName: string
}

/** The owner's block — the same numbers docs/03 was written against. */
export const LAMITJA_2027: BlockConfig = {
  startsOn: Date.UTC(2026, 7, 17),
  raceOn: Date.UTC(2027, 0, 24),
  goalTimeS: 4799,
  raceDistanceM: HALF_MARATHON_M,
  raceName: 'La Mitja',
}

export const totalWeeks = (block: BlockConfig) => Math.ceil((block.raceOn - block.startsOn) / WEEK_MS)
export const weekIndex = (block: BlockConfig, at: number) => Math.floor((startOfWeek(at) - block.startsOn) / WEEK_MS)
export const weekStart = (block: BlockConfig, i: number) => block.startsOn + i * WEEK_MS
export const weekDays = (block: BlockConfig, i: number) => number[]
export const daysToRace = (block: BlockConfig, at: number) => Math.max(0, Math.round((block.raceOn - startOfDay(at)) / DAY_MS))
export const goalPaceSKm = (block: BlockConfig) => block.goalTimeS / (block.raceDistanceM / 1000)
/** Guardrails for the wizard and the zod schemas. */
export const MIN_BLOCK_WEEKS = 4
export const MAX_BLOCK_WEEKS = 40
```

`block` is always the **first** parameter of any function that takes one. Every module
that used the constants now takes a `BlockConfig`:

- `plan.ts`: `weekStart`/`weekDays` move out (they live in `block.ts` now); `buildWeek(block, index, …)`, `buildBlock(block, weeks, sessions, activities)` — drop the `totalWeeks` argument, derive it.
- `metrics.ts`: `GOAL_PACE_S_KM` becomes `goalPaceSKm(block)`; `blockProgress(block, weeks, now)`.
- `analytics.ts`: `weeklyTotals(activities, totalWeeks)` unchanged (already takes a count); `projectHalf(efforts, distanceM)` takes the athlete's race distance.
- `plan-input.ts`: the `inBlock` refinement needs the block, so the schemas become
  factories — `sessionInputs(block)` returning `{ createSessionInput, updateSessionInput }`.
  `updateWeekInput` is block-free and stays a constant.
- `seed.ts`: `buildPlan(now)` stays exactly as it is — it is the owner's hand-written plan
  against `LAMITJA_2027`, and it must keep producing byte-identical output. Do not
  generalise it; the generator below is the general path.
- `workout.ts`: only uses `PACES`; see below.

### Paces derive from the goal

`src/lib/paces.ts`: the six bands stop being literals and become ratios of goal pace, so
another athlete's plan is prescribed at their target rather than at Ivan's.

```ts
/** The bands docs/03 §4 prescribes, and the goal pace they were written for. */
const REF = { goalPaceSKm: 4799 / 21.0975, bands: { easy: {lo:300,hi:330}, long: {lo:285,hi:310}, steady: {lo:260,hi:275}, threshold: {lo:230,hi:238}, race: {lo:225,hi:227}, vo2: {lo:210,hi:220} } }
/** Each band as a multiple of goal pace — derived from REF so the two cannot drift. */
export const PACE_RATIO: Record<PaceZone, PaceBand>
export function paceBands(goalPaceSKm: number): Record<PaceZone, PaceBand>   // rounded to whole seconds
/** The owner's table, unchanged in value. A test asserts it equals the literals above. */
export const PACES = paceBands(REF.goalPaceSKm)
```

`hrZone(bpm)` becomes `hrZone(bpm, hrMax)`; `ZONE_FLOOR_BPM` becomes
`zoneFloorsBpm(hrMax)`. `HR_MAX` is renamed `DEFAULT_HR_MAX = 192` and is only the
fallback for a user with no `hr_max` set.

### Baseline stays the owner's

`baseline.ts` keeps its constants but exports them behind a key, because the CSVs are one
athlete's history:

```ts
export const BASELINE_KEY = 'ivan-2025-26'
export function baselineFor(key: string | null): { activities: Activity[]; preBlock: Activity[]; firstWeek: number } | null
```

It shifts against `LAMITJA_2027` as today. Any UI that draws a baseline comparison
renders nothing when `baselineFor(user.baselineKey)` is null — absent, not zero.

---

## 4. Strava, per athlete

- `src/lib/strava.ts`: every function that touched `app_state` now takes a user.
  `accessToken(db, userId)`, `saveTokens(db, userId, tokens)`. `authorizeUrl` unchanged.
- `src/lib/accounts.ts` (new, replaces `state.ts`): `getAccount(db, userId)`,
  `upsertAccount(db, userId, patch)`, `findByAthleteId(db, athleteId)`, `listAccounts(db)`,
  `setLastSync(db, userId, at)`.
- `src/lib/sync.ts`: `syncBlock(db, user)` where `user` carries id + block; fetches after
  `block.startsOn`, upserts with `userId` on every row, writes `lastSyncAt` on the account.
- `/api/strava/connect`: the KV state token now stores the user id —
  `CACHE.put('oauth:'+state, userId, { expirationTtl: 600 })`.
- `/api/strava/callback`: reads the user id back out of KV, saves the tokens against it,
  and rejects a Strava athlete already connected to a different user (409 → `/?strava=taken`).
- `/api/strava/webhook`: **stops ignoring the body.** Read `owner_id`, look the athlete up
  in `strava_accounts`, sync only that user. Unknown athlete → 200 and no work (Strava
  must never see an error).
- `src/lib/scheduled.ts`: iterate `listAccounts(db)` and sync each in sequence, catching
  per user so one dead token cannot skip the rest. Log a per-user line.

Rate limits stay a non-issue: a handful of athletes at one full-block fetch each per
night is far under 100 reads / 15 min.

---

## 5. The plan generator

New `src/lib/generator.ts` — pure, browser-safe, no drizzle, no zod, no clock. This is the
path every athlete but the owner gets a plan through.

```ts
export interface PlanInput {
  block: BlockConfig
  /** Weekly running volume, km, at the start of the block and at the peak. */
  startVolumeKm: number
  peakVolumeKm: number
  /** Which weekdays are training days. 0 = Monday. */
  runDays: number[]           // 3–6 entries
  longRunDay: number          // must be in runDays
  qualityDays: number[]       // 0–2 entries, must be in runDays, never adjacent
  strengthDays: number[]      // 0–2 entries; may share a day with a run
  /** Weeks 0..n where a cutback lands. Default: every 4th week, never the first of a phase. */
  downWeekEvery: number       // 3–5, default 4
  /** Extra dorsals inside the block. */
  races: { on: number; distanceM: number; title: string }[]
  /** Opens the block with a rebuild phase — easy running only, no quality. */
  rebuildWeeks: number        // default 0
}

export interface GeneratedPlan { weeks: NewPlanWeek[]; sessions: NewPlanSession[] }
export function generatePlan(input: PlanInput, now: number): GeneratedPlan
/** Every reason the input cannot be built, in Spanish, for the wizard to render. */
export function validatePlanInput(input: PlanInput): string[]
```

It must reuse the ideas the hand-written seed already proves, not invent new ones:

- **Phases scaled to the block.** After `rebuildWeeks`, split the remainder ≈40% base,
  ≈30% threshold, ≈20% specific, and a taper of `min(2, ceil(weeks*0.1))` weeks. Phase
  names are the ones already in use: `reconstrucción`, `base`, `umbral`, `específico`,
  `puesta a punto`. The `focus` line per phase is written prose in Spanish, one sentence.
- **The ramp** is linear from `startVolumeKm` to `peakVolumeKm` across base+threshold,
  peaks at the start of the specific phase and falls to ~45% of peak on race week. Cap
  week-on-week growth at 10% (`MAX_WEEKLY_GROWTH`), cut a down week to 75%. Copy the
  shape of `rawRampKm` / `CAPPED_RAMP_KM` in `seed.ts`.
- **Quality per phase**, as structured `Step[]` built with the `workout.ts` helpers, at
  bands from `paceBands(goalPaceSKm(block))`:
  - rebuild: none — easy running and strides only.
  - base: one quality day — fartlek, or `6–8 × 400 m @ vo2` with a 90 s jog, alternating.
  - threshold: two — long reps (`5–6 × 1 km @ threshold`, 90 s jog) and a tempo
    (`3–5 km @ threshold` inside a warm-up/cool-down).
  - specific: two — race-pace reps (`4–5 × 2 km @ race`, 2 min jog) and a long run with
    the last third at race pace.
  - taper: one — short and sharp (`5–6 × 800 m @ race`, or strides).
  A quality day never lands the day after another quality day; if `qualityDays` forces it,
  `validatePlanInput` says so.
- **The long run** is on `longRunDay`, 28–32% of the week's volume, capped at
  `raceDistanceM * 1.05` for a half and at 150 min of estimated time.
- **Only the easy runs are computed**, exactly as `sizeEasyRuns` does today: the
  prescribed sessions are paid for first and the easy days absorb the remainder, floored
  at 4 km. A week's `targetVolumeM` is the sum of what its sessions actually prescribe.
- **Race weeks**: a `races` entry replaces that week's quality; the week around it is a
  cutback; race day itself is a `race` session with warm-up and cool-down steps.
- **Ids** are the same slug shape as the seed — `w03-tue-1` — so re-generating resets in
  place instead of duplicating.

Tests (`test/unit/generator.test.ts`) must cover: every week has ≤ the prescribed number
of quality days and no two adjacent; weekly volume never grows more than 10%; the sum of a
week's session distances equals its `targetVolumeM`; a 23-week input with Ivan's shape
lands within ~15% of `buildPlan`'s weekly volumes; `validatePlanInput` rejects a long run
that is not a run day, adjacent quality days, and a block outside 4–40 weeks.

---

## 6. API surface

Every route reads `context.locals.user` and scopes its queries to `user.id`.

| Route | Method | Body → response |
|---|---|---|
| `/api/bootstrap` | POST | `{password, email, newPassword, displayName}` → 204 + cookie. 409 once bootstrapped. |
| `/api/login` | POST | `{email, password}` (JSON) → 204 + cookie; 401 `Correo o contraseña incorrectos`. |
| `/api/login` | DELETE | → 204 + cleared cookie |
| `/api/register` | POST | `{token, email, password, displayName}` → 204 + cookie; 400 `Invitación no válida o ya usada` |
| `/api/invites` | GET | admin → `{invites: [{note, expiresAt, usedAt, usedBy}]}` |
| `/api/invites` | POST | admin, `{note?}` → `{url, expiresAt}` — the token is returned once, never again |
| `/api/profile` | PATCH | `{displayName?, hrMax?, block?: BlockConfig}` → the updated user + block |
| `/api/data` | GET | → `{user, block, baseline, stravaConnected, athlete, lastSyncAt, activities, weeks, sessions}` |
| `/api/plan/generate` | POST | `PlanInput` (dates as epoch ms) → `{weeks, sessions}` counts. Replaces the athlete's plan wholesale: delete then insert, inside one `db.batch`. |
| `/api/plan/seed` | POST | owner only (`baselineKey === BASELINE_KEY`) → unchanged behaviour |
| `/api/plan/sessions`, `/api/plan/sessions/[id]`, `/api/plan/weeks/[index]` | | unchanged shape, now scoped by `user.id` in every where-clause |
| `/api/activities/[id]` | GET | unchanged, plus `eq(activities.userId, user.id)` in the lookup |
| `/api/sync` | POST | syncs the calling user only |

Validation lives in `src/lib/auth-input.ts` (new, zod, Worker-only): `loginInput`,
`registerInput`, `bootstrapInput`, `profileInput`, `inviteInput`, `planInputSchema`.
Password rule: 10–200 characters. Email: `z.email()`, normalised.

`/api/data` payload additions the client relies on:

```ts
user: { id, displayName, email, isAdmin, hrMax }
block: BlockConfig
baseline: boolean          // whether this athlete has a season to compare against
hasPlan: boolean           // sessions.length > 0 — what /crear-plan redirects on
```

---

## 7. UI

Spanish, existing tokens, existing type ramp, no new colours, no new fonts.

- `/login` — email + password. Same layout as today; the hero `1:19:59` stays only for the
  owner's build… it is a static page, so keep it as is. Add a line under the form:
  *¿Tienes una invitación?* linking to `/alta`.
- `/alta` — accept an invite. Reads `?token=` **inside an effect** (gotcha 15). Fields:
  name, email, password, repeat. On success → `/bienvenida`.
- `/bienvenida` — first-run: race name, race date, goal time, block start (defaults to the
  Monday of this week), then straight into the wizard below. One island, `Onboarding.tsx`.
- `/crear-plan` — the plan wizard, `PlanWizard.tsx`: volume start/peak, run days, long-run
  day, quality days, strength days, races. Live preview of the weekly ramp using the same
  bar chart component `/progreso` already uses, then *Crear plan* → `POST /api/plan/generate`.
  Warn plainly that it replaces the existing plan.
- `/ajustes` — profile: display name, max HR, block dates/goal (PATCH `/api/profile`),
  Strava connect/disconnect, *Regenerar plan* linking to `/crear-plan`, sign out, and —
  for an admin only — an **Invitaciones** card that mints a link and copies it to the
  clipboard. No new page for invites.
- `src/layouts/App.astro` gains a header affordance to `/ajustes` (the athlete's initials
  in a circle, `h-11` target). The dock stays four tabs — `nav.ts` is not touched.
- `useBlock` returns `block: BlockConfig` and `user` alongside what it returns today, and
  every component that imports `TOTAL_WEEKS`/`BLOCK_START`/`GOAL_PACE_S_KM` reads them off
  the block instead. Components must not import `LAMITJA_2027`.
- Baseline comparisons on `/progreso` and `/` render only when `data.baseline` is true.

---

## 8. Config

New secrets, added to `.dev.vars.example` and documented in AGENTS.md:

```
SESSION_SECRET=""     # openssl rand -base64 32 — rotating it signs every device out
APP_PASSWORD=""       # now only the one-time bootstrap secret for the first admin
```

`wrangler.jsonc` is unchanged apart from nothing — no new bindings. KV keeps holding
single-use OAuth state, now with the user id as its value.

---

## 9. Invariants that must survive

1. No query returns a row belonging to another athlete.
2. `buildPlan` still produces the owner's plan byte-identically; `PACES` still equals the
   six literal bands.
3. Every date is still local-wall-clock epoch ms; `block` is always the first argument.
4. `plan.ts`, `workout.ts`, `paces.ts`, `generator.ts`, `block.ts` still import neither
   drizzle nor zod — they ship to the browser.
5. Spanish for every string a person reads; English for identifiers and comments.
6. Only `src/pages/api/**` sets `prerender = false`.
7. Nothing in the repo is unreferenced.
