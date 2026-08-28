import { and, asc, eq, getTableColumns, gte, inArray, lte, sql, type SQL } from 'drizzle-orm'
import {
  DAY_MS,
  daysToRace,
  goalPaceSKm,
  startOfDay,
  totalWeeks,
  wallClockNow,
  weekIndex,
  weekStart,
  type BlockConfig,
} from '../block'
import { formatClock, formatPace, paceSKm, parsePace } from '../activity'
import {
  activityLoad,
  bestEfforts,
  fitnessSeries,
  formLabel,
  projectHalf,
  summarise,
  weeklyTotals,
  zoneCoverage,
  zoneShares,
} from '../analytics'
import type { Database } from '../db/client'
import {
  activities,
  planSessions,
  planWeeks,
  type Activity,
  type NewPlanSession,
  type PlanSession,
  type PlanWeek,
} from '../db/schema'
import { weekMetrics } from '../metrics'
import {
  PACE_ZONES,
  PACE_ZONE_NUMBER,
  ZONE_LABEL,
  hrZone,
  paceBands,
  type PaceBand,
  type PaceZone,
} from '../paces'
import { sessionInputs, updateWeekInput } from '../plan-input'
import {
  SESSION_META,
  SESSION_TYPES,
  buildBlock,
  type MatchedSession,
  type SessionType,
  type WeekPlan,
} from '../plan'
import { RECOVERY_KINDS, STEP_KINDS, formatWorkout, workoutDistanceM, type Bands, type Step } from '../workout'
import type { ToolDefinition, ToolRegistry, ToolResult } from './protocol'

/**
 * The tools an agent gets, and what they do.
 *
 * **These names and descriptions are English, and that is not a violation of the
 * Spanish-for-humans rule.** Every string a *person* reads in this app is Spanish; the
 * reader here is a language model deciding what to write into a training plan, and the
 * vocabulary it reasons in — `weekIndex`, `targetDistanceM`, "quality session" — is the
 * codebase's, not the athlete's. The data flowing through does not change language: a
 * session's `title` and `notes` are read by the athlete on his phone, so the instructions
 * tell the agent to write those in Spanish.
 *
 * **The JSON Schemas are written by hand, not generated from the zod validators.** Two
 * reasons. `z.toJSONSchema` cannot represent `scheduledOn`, which is a `.transform()`, and
 * would fail on it outright. And a generated schema carries no prose — which would throw
 * away the entire point, because the descriptions *are* the interface here. A model
 * choosing between `targetDurationS` and `targetDistanceM` needs to be told that one is
 * seconds and the other metres and that a run uses the second; a `{"type":"number"}` tells
 * it nothing. Validation is still zod's: everything below is converted into the shape
 * `plan-input.ts` describes and handed to the very same schemas the HTTP routes use, so
 * the two surfaces cannot drift apart about what a valid session is.
 *
 * **Types at this boundary differ from the database's on purpose.** Dates are ISO
 * `YYYY-MM-DD` strings and paces are `mm:ss` per kilometre, both converted at the edge —
 * an agent should never be asked to compute epoch milliseconds, and `227` is not a pace
 * anybody writes down. Distances stay in metres and durations in seconds, exactly as
 * stored, and every description says so.
 */

// ---------------------------------------------------------------------------
// The boundary conversions — one small place, tested directly
// ---------------------------------------------------------------------------

/**
 * A failure the agent caused and can fix: a malformed date, a session outside the block,
 * a batch with two rows sharing an id. It comes back as `isError` content rather than as a
 * JSON-RPC error, because "here is what is wrong with row 7" is a result to act on.
 */
export class ToolError extends Error {
  constructor(
    message: string,
    readonly details?: unknown,
  ) {
    super(message)
    this.name = 'ToolError'
  }
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/

/** `2026-08-17` from epoch ms — the day the stored wall clock falls on. */
export const toIsoDate = (at: number): string =>
  new Date(startOfDay(at)).toISOString().slice(0, 10)

/**
 * `2026-08-17` → UTC midnight, which is the scale every date in this app lives on
 * (`AGENTS.md`: stored dates are the athlete's wall clock pinned to UTC).
 *
 * The round-trip check is what rejects `2026-02-30`: `Date.UTC` rolls it forward to 2 March
 * rather than complaining, and a session silently scheduled thirteen days from where the
 * agent asked is worse than an error.
 */
export function fromIsoDate(value: string): number {
  const match = ISO_DATE.exec(typeof value === 'string' ? value.trim() : '')
  if (!match) throw new ToolError(`"${String(value)}" is not a date; use YYYY-MM-DD.`)

  const at = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
  if (toIsoDate(at) !== match[0]) throw new ToolError(`"${match[0]}" is not a real date.`)
  return at
}

/** `3:47` from 227 s/km. The app's own formatter — the MCP surface adds no second one. */
export const toPace = (secondsPerKm: number): string => formatPace(secondsPerKm)

/** `3:47` → 227 s/km, rejecting anything that is not `m:ss` so a typo never saves as zero. */
export function fromPace(value: string): number {
  const parsed = typeof value === 'string' ? parsePace(value) : null
  if (parsed === null) throw new ToolError(`"${String(value)}" is not a pace; use mm:ss per km, e.g. 3:47.`)
  return parsed
}

const round = (value: number, digits = 0): number => {
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

// ---------------------------------------------------------------------------
// Reading the block
// ---------------------------------------------------------------------------

/**
 * The same three tables `/api/data` reads, run through the same `buildBlock` the app draws
 * its planner from. Plan-to-actual matching is not reimplemented here: the agent asking
 * "was Tuesday's session done" must get the answer the athlete sees on the phone, and
 * there is exactly one function that decides it.
 */
async function readBlock({ db, userId, block }: McpCtx) {
  const [weeks, sessions, acts] = await Promise.all([
    db.select().from(planWeeks).where(eq(planWeeks.userId, userId)).orderBy(asc(planWeeks.weekIndex)),
    db
      .select()
      .from(planSessions)
      .where(eq(planSessions.userId, userId))
      .orderBy(asc(planSessions.scheduledOn), asc(planSessions.dayOrder)),
    db
      .select()
      .from(activities)
      .where(and(eq(activities.userId, userId), gte(activities.startedOn, block.startsOn))),
  ])

  const plan = buildBlock(block, weeks, sessions, acts)
  const matched = new Map<string, MatchedSession>()
  for (const week of plan) for (const m of week.sessions) matched.set(m.session.id, m)

  return { sessions, plan, matched }
}

/**
 * Everything a tool is allowed to touch, resolved once per request from the bearer token.
 *
 * It replaces the bare `Database` the single-athlete version passed around, and the reason
 * is the whole security model of this server: a tool that is handed a connection can query
 * anything, and a tool that is handed a *context* has an athlete's id sitting next to it in
 * every signature. Every query below filters on `userId`, and there is no path that reaches
 * the database without going through here.
 *
 * `block`, `hrMax` and `bands` come with it so no tool re-derives them, and so none of them
 * can accidentally reach for a module-level default that belongs to the owner.
 */
export interface McpCtx {
  db: Database
  /** The athlete this token belongs to. Every row read or written is filtered on it. */
  userId: string
  block: BlockConfig
  hrMax: number
  /** The athlete's six pace bands, from their own goal — never the owner's table. */
  bands: Record<PaceZone, PaceBand>
}

/**
 * What a week's sessions actually add up to, in metres.
 *
 * `plan_weeks.targetVolumeM` is the ramp figure the sessions were *sized from*; this is
 * what they prescribe, and where the two disagree the sessions are the truth. `SESSION_META`
 * decides which types count — a strength session is not running volume — which is the same
 * filter `WeekCalendar` draws its week bar from and the same one the app sums a week's
 * target with.
 */
const prescribedVolumeM = (matched: MatchedSession[]): number =>
  matched
    .filter((m) => SESSION_META[m.session.type].countsAsVolume)
    .reduce((sum, m) => sum + (m.session.targetDistanceM ?? 0), 0)

// ---------------------------------------------------------------------------
// Serialisers — the database's units on the way out, its dates translated
// ---------------------------------------------------------------------------

function weekShape(block: BlockConfig, index: number, row: PlanWeek | null) {
  const monday = weekStart(block, index)
  return {
    weekIndex: index,
    startsOn: toIsoDate(monday),
    endsOn: toIsoDate(monday + 6 * DAY_MS),
    phase: row?.phase ?? null,
    focus: row?.focus ?? null,
    targetVolumeM: row?.targetVolumeM ?? null,
    isDownWeek: row?.isDownWeek ?? false,
    notes: row?.notes ?? null,
  }
}

function weekOut(block: BlockConfig, plan: WeekPlan) {
  const metrics = weekMetrics(plan)
  return {
    ...weekShape(block, plan.weekIndex, plan.week),
    prescribedVolumeM: round(prescribedVolumeM(plan.sessions)),
    sessionsPlanned: metrics.sessionsPlanned,
    sessionsDone: metrics.sessionsDone,
    actual: {
      runs: metrics.totals.runs,
      distanceM: round(metrics.totals.distanceM),
      movingS: metrics.totals.movingS,
      longestM: round(metrics.totals.longestM),
    },
  }
}

function sessionOut(block: BlockConfig, session: PlanSession, match?: MatchedSession) {
  return {
    id: session.id,
    date: toIsoDate(session.scheduledOn),
    weekIndex: weekIndex(block, session.scheduledOn),
    dayOrder: session.dayOrder,
    type: session.type,
    isQuality: SESSION_META[session.type].isQuality,
    title: session.title,
    notes: session.notes,
    steps: session.steps,
    /** The steps as the app renders them — Spanish, because that is the app's own prose. */
    workout: session.steps?.length ? formatWorkout(session.steps) : null,
    targetDistanceM: session.targetDistanceM,
    targetDurationS: session.targetDurationS,
    targetPaceLo: session.targetPaceLoSKm == null ? null : toPace(session.targetPaceLoSKm),
    targetPaceHi: session.targetPaceHiSKm == null ? null : toPace(session.targetPaceHiSKm),
    doneAt: session.doneAt == null ? null : toIsoDate(session.doneAt),
    done: match ? match.done : session.doneAt != null,
    activityId: match?.activity?.id ?? session.activityId,
  }
}

/**
 * An activity as the agent sees it.
 *
 * The average heart rate comes out as its zone rather than as a number of beats, which is
 * the same rule the screens follow (`AGENTS.md`: intensity is Z1–Z5, never a heart rate).
 * The bpm drifts with heat, sleep and the strap, no decision in the plan is made on it,
 * and handing a model a number nothing else in the app trusts invites it to reason from
 * one. Cadence is the exception and is given in full: it is the primary marker in the knee
 * protocol, in steps per minute.
 */
function activityOut(activity: Activity, hrMax: number) {
  const pace = paceSKm(activity.distanceM, activity.movingS)
  return {
    id: activity.id,
    date: toIsoDate(activity.startedOn),
    name: activity.name,
    sportType: activity.sportType,
    distanceM: round(activity.distanceM),
    movingS: activity.movingS,
    paceSKm: pace > 0 ? round(pace) : null,
    pace: pace > 0 ? toPace(pace) : null,
    elevationGainM: activity.elevationGainM == null ? null : round(activity.elevationGainM),
    cadenceSpm: activity.cadenceSpm,
    hrZone: activity.averageHeartrate == null ? null : hrZone(activity.averageHeartrate, hrMax),
    load: round(activityLoad(activity)),
  }
}

// ---------------------------------------------------------------------------
// The brief — pure, so it is testable without a database
// ---------------------------------------------------------------------------

/**
 * Everything an agent needs before it writes a single session: where the block starts and
 * ends, what it is aiming at, the pace vocabulary, the session vocabulary and the step
 * vocabulary. One call, because a plan written against half of this is a plan that has to
 * be rewritten.
 */
export function blockBrief({ block, bands, hrMax }: McpCtx, now: number) {
  const goalPace = goalPaceSKm(block)
  return {
    race: {
      name: block.raceName,
      date: toIsoDate(block.raceOn),
      distanceM: block.raceDistanceM,
      daysToRace: daysToRace(block, now),
    },
    block: {
      startsOn: toIsoDate(block.startsOn),
      endsOn: toIsoDate(block.raceOn),
      totalWeeks: totalWeeks(block),
      weekStartsOn: 'monday',
    },
    goal: {
      time: formatClock(block.goalTimeS),
      timeS: block.goalTimeS,
      pace: toPace(goalPace),
      paceSKm: round(goalPace, 1),
    },
    athlete: { hrMax },
    today: { date: toIsoDate(now), weekIndex: weekIndex(block, now) },
    paceZones: PACE_ZONES.map((zone) => ({
      zone,
      zoneNumber: PACE_ZONE_NUMBER[zone],
      label: ZONE_LABEL[zone],
      lo: toPace(bands[zone].lo),
      hi: toPace(bands[zone].hi),
      loSKm: bands[zone].lo,
      hiSKm: bands[zone].hi,
    })),
    sessionTypes: SESSION_TYPES.map((type) => ({
      type,
      label: SESSION_META[type].label,
      family: SESSION_META[type].family,
      countsAsVolume: SESSION_META[type].countsAsVolume,
      isQuality: SESSION_META[type].isQuality,
    })),
    stepKinds: [...STEP_KINDS],
    recoveryKinds: [...RECOVERY_KINDS],
    units: {
      distance: 'metres',
      duration: 'seconds',
      pace: 'mm:ss per kilometre',
      date: 'YYYY-MM-DD',
      cadence: 'steps per minute',
    },
  }
}

// ---------------------------------------------------------------------------
// Turning MCP arguments into what plan-input.ts validates
// ---------------------------------------------------------------------------

interface Issue {
  path: string
  message: string
}

/**
 * The blanks a step falls back to.
 *
 * `plan-input.ts` requires all seven fields of a step, because the editor always sends all
 * seven; asking an agent to write `distanceM: null, durationS: null, recovery: null` on a
 * warm-up would be six words of ceremony per step and a hundred per plan. `kind` is not in
 * here on purpose — it is the one field with no sensible blank, so an omitted one still
 * fails validation by name.
 */
const STEP_BLANK = { reps: 1, distanceM: null, durationS: null, zone: null, recovery: null, note: null }
const RECOVERY_BLANK = { distanceM: null, durationS: null }

function fillStep(raw: unknown): unknown {
  if (!isRecord(raw)) return raw
  const recovery = isRecord(raw.recovery) ? { ...RECOVERY_BLANK, ...raw.recovery } : (raw.recovery ?? null)
  return { ...STEP_BLANK, ...raw, recovery }
}

/** Column names the boundary renames, mapped back so an error points at what was written. */
const MCP_FIELD: Record<string, string> = {
  targetPaceLoSKm: 'targetPaceLo',
  targetPaceHiSKm: 'targetPaceHi',
}

/**
 * Rewrites one MCP-shaped session into the shape `plan-input.ts` validates.
 *
 * Only the three type changes happen here — ISO date to epoch ms, `mm:ss` to s/km, and
 * filling a step's blanks — and every other key is carried across untouched by name. What
 * this deliberately does *not* do is decide anything: whether the date is inside the block,
 * whether the pace is positive, whether the zone exists, all of that is still zod's, on the
 * same schema `POST /api/plan/sessions` runs. An absent key stays absent, which is what
 * lets `update_session` mean "leave that column alone".
 */
function toSessionFields(args: Record<string, unknown>): {
  value: Record<string, unknown>
  issues: Issue[]
} {
  const issues: Issue[] = []
  const value: Record<string, unknown> = {}

  for (const key of [
    'dayOrder',
    'type',
    'title',
    'notes',
    'targetDistanceM',
    'targetDurationS',
    'activityId',
  ]) {
    if (key in args) value[key] = args[key]
  }

  const date = (key: 'scheduledOn' | 'doneAt') => {
    if (!(key in args)) return
    if (args[key] === null) {
      value[key] = null
      return
    }
    try {
      value[key] = fromIsoDate(args[key] as string)
    } catch (cause) {
      issues.push({ path: key, message: (cause as Error).message })
    }
  }
  date('scheduledOn')
  date('doneAt')

  const pace = (key: 'targetPaceLo' | 'targetPaceHi', column: string) => {
    if (!(key in args)) return
    if (args[key] === null) {
      value[column] = null
      return
    }
    try {
      value[column] = fromPace(args[key] as string)
    } catch (cause) {
      issues.push({ path: key, message: (cause as Error).message })
    }
  }
  pace('targetPaceLo', 'targetPaceLoSKm')
  pace('targetPaceHi', 'targetPaceHiSKm')

  if ('steps' in args) {
    value.steps = Array.isArray(args.steps) ? args.steps.map(fillStep) : args.steps
  }

  return { value, issues }
}

type SessionSchema =
  | ReturnType<typeof sessionInputs>['createSessionInput']
  | ReturnType<typeof sessionInputs>['updateSessionInput']

function parseSession(
  args: Record<string, unknown>,
  schema: SessionSchema,
): { data: Record<string, unknown> } | { issues: Issue[] } {
  const { value, issues } = toSessionFields(args)
  const parsed = schema.safeParse(value)

  const all = [
    ...issues,
    ...(parsed.success
      ? []
      : parsed.error.issues.map((issue: { path: PropertyKey[]; message: string }) => {
          const path = issue.path.map(String)
          if (path[0] && MCP_FIELD[path[0]]) path[0] = MCP_FIELD[path[0]]
          return { path: path.join('.'), message: issue.message }
        })),
  ]

  return all.length > 0 ? { issues: all } : { data: parsed.success ? parsed.data : {} }
}

/**
 * The stored distance of a session that carries steps is what those steps add up to.
 *
 * `targetDistanceM` is the column every screen sums and the one the activity matcher
 * measures against, and this boundary is the write time — the seed used to compute it
 * with `workoutDistanceM` before inserting, and a session written here without it is
 * invisible to the week bars and unmatchable to a run. Derived with the athlete's own
 * bands so a timed step is costed at their paces, never the owner's table. An explicit
 * `steps: null` leaves a hand-set distance alone, which is what keeps update_session's
 * two documented modes — "change the number, drop the steps" and "rewrite the steps" —
 * both true.
 */
export function withDerivedDistance(
  data: Record<string, unknown>,
  bands: Bands,
): Record<string, unknown> {
  const steps = data.steps as Step[] | null | undefined
  if (!Array.isArray(steps) || steps.length === 0) return data
  const type = data.type as SessionType | undefined
  if (type && !SESSION_META[type].countsAsVolume) return data
  return { ...data, targetDistanceM: workoutDistanceM(steps, bands) }
}

/**
 * A session id an agent may choose.
 *
 * The HTTP surface generates ids server-side so that a stale browser tab cannot overwrite
 * a session it never saw; an agent authoring a plan is the opposite case. A stable slug
 * (`w03-tue-1`, derived from week and weekday) makes "write me a 16-week plan" idempotent —
 * running it twice rewrites the plan instead of leaving two of every session behind. That
 * is why this validator lives here and not in `plan-input.ts`: the id is not part of what
 * either surface considers a valid *session*, it is a property of who is doing the writing.
 */
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

function readId(raw: unknown): string {
  if (raw === undefined || raw === null) return crypto.randomUUID()
  if (typeof raw !== 'string' || !ID.test(raw)) {
    throw new ToolError(
      `"${String(raw)}" is not a usable id: 1–64 characters, letters, digits, dot, dash or underscore, starting with a letter or digit.`,
    )
  }
  return raw
}

function readIsoArg(args: Record<string, unknown>, key: string): number | undefined {
  if (args[key] === undefined || args[key] === null) return undefined
  return fromIsoDate(args[key] as string)
}

function readWeekIndex(block: BlockConfig, raw: unknown): number {
  const weeks = totalWeeks(block)
  if (!Number.isInteger(raw) || (raw as number) < 0 || (raw as number) >= weeks) {
    throw new ToolError(`weekIndex must be an integer between 0 and ${weeks - 1}.`)
  }
  return raw as number
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/** D1 rejects a query with more than 100 bound parameters — far tighter than SQLite's 999. */
const D1_MAX_BOUND_PARAMS = 100

const columnsOf = (table: typeof planWeeks | typeof planSessions) =>
  Object.keys(getTableColumns(table)).length

/**
 * Rows per statement, derived from the column count rather than hardcoded, so a column
 * added to the schema cannot silently push a statement over D1's limit. Same derivation as
 * `src/lib/sync.ts`.
 */
const chunkSize = (table: typeof planWeeks | typeof planSessions) =>
  Math.max(1, Math.floor(D1_MAX_BOUND_PARAMS / columnsOf(table)))

/**
 * Every column but the key ones, so an upsert overwrites rather than skipping.
 *
 * `userId` is always among them: the keys here are composite — `(user_id, week_index)` and
 * `(user_id, id)` — and a SET that reassigns the owner of a row on conflict is a sentence
 * nobody should ever be able to write by accident.
 */
const excludedSet = (table: typeof planWeeks | typeof planSessions, keys: string[]) =>
  Object.fromEntries(
    Object.entries(getTableColumns(table))
      .filter(([name]) => !keys.includes(name))
      .map(([name, column]) => [name, sql`excluded.${sql.identifier(column.name)}`]),
  )

/**
 * Refuses a pin onto somebody else's run.
 *
 * `plan_sessions.activity_id` references `activities(id)` alone, and a Strava activity id
 * is global — so the foreign key is perfectly happy to let one athlete pin another
 * athlete's activity to their own session. The database cannot catch this: the row it is
 * pointing at genuinely exists. `src/pages/api/plan/sessions/[id].ts` checks it on the HTTP
 * side and this is the same check on the MCP side, because "the agent path forgot the
 * guard the form path has" is exactly how a hole of this kind survives.
 *
 * One query for the whole batch rather than one per row: `create_sessions` writes a season
 * at a time.
 */
async function assertOwnsActivities(
  { db, userId }: McpCtx,
  rows: { activityId?: number | null }[],
): Promise<void> {
  const wanted = [...new Set(rows.map((row) => row.activityId).filter((id): id is number => id != null))]
  if (wanted.length === 0) return

  const owned = await db
    .select({ id: activities.id })
    .from(activities)
    .where(and(eq(activities.userId, userId), inArray(activities.id, wanted)))

  const have = new Set(owned.map((row) => row.id))
  const missing = wanted.filter((id) => !have.has(id))
  if (missing.length > 0) {
    throw new ToolError(
      `No activity of yours with id ${missing.join(', ')}. Pin only activities from list_activities.`,
    )
  }
}

// ---------------------------------------------------------------------------
// JSON Schema fragments
// ---------------------------------------------------------------------------

const isoDate = (description: string) => ({
  type: 'string',
  pattern: '^\\d{4}-\\d{2}-\\d{2}$',
  description,
})

const paceString = (description: string) => ({
  type: ['string', 'null'],
  pattern: '^\\d{1,3}:[0-5]\\d$',
  description,
})

const RECOVERY_SCHEMA = {
  type: ['object', 'null'],
  description:
    'What happens between two repetitions, so a set of N reps has N−1 of them. Its distance is added to the week volume, which is why it is data and not a note. Omit for a step that does not repeat.',
  required: ['kind'],
  properties: {
    kind: {
      type: 'string',
      enum: [...RECOVERY_KINDS],
      description:
        '"jog" is the slow running between reps; "float" the easy running between fartlek surges; "walk" and "standing" are what they say.',
    },
    distanceM: { type: ['number', 'null'], description: 'Metres. Set this or durationS, not both.' },
    durationS: { type: ['integer', 'null'], description: 'Seconds. Set this or distanceM, not both.' },
  },
} as const

const STEPS_SCHEMA = {
  type: ['array', 'null'],
  maxItems: 24,
  description:
    'The workout as data: warm-up, the effort, cool-down. This is what lets the app count repetitions, fold recovery jogs into the week volume and know the pace of a rep — never write the workout as prose in `notes`. Pass null to clear an existing breakdown. The session\'s distance and estimated duration are derived from these steps, so do not also set targetDistanceM when you set steps.',
  items: {
    type: 'object',
    required: ['kind'],
    properties: {
      kind: {
        type: 'string',
        enum: [...STEP_KINDS],
        description:
          '"warmup" / "cooldown" bracket the session; "rep" is a repeated effort; "steady" is a continuous block; "strides" is a count of short accelerations.',
      },
      reps: {
        type: 'integer',
        minimum: 1,
        maximum: 60,
        description: 'How many times the effort repeats. Defaults to 1.',
      },
      distanceM: { type: ['number', 'null'], description: 'Metres, per repetition. e.g. 1000 for 1 km reps.' },
      durationS: { type: ['integer', 'null'], description: 'Seconds, per repetition, for a step measured in time.' },
      zone: {
        type: ['string', 'null'],
        enum: [...PACE_ZONES, null],
        description:
          'Which pace band the effort is run at; see get_block.paceZones. null means "by feel", which is a deliberate prescription during a rebuild, not a missing value.',
      },
      recovery: RECOVERY_SCHEMA,
      note: { type: ['string', 'null'], maxLength: 300, description: 'Coaching prose for this step. Spanish.' },
    },
  },
} as const

const SESSION_FIELDS = {
  scheduledOn: isoDate('The day it is run, YYYY-MM-DD. Must fall inside the block; see get_block.'),
  dayOrder: {
    type: 'integer',
    minimum: 0,
    maximum: 9,
    description: 'Orders sessions within one day, so a run and a strength session have a fixed sequence. Defaults to 0.',
  },
  type: {
    type: 'string',
    enum: [...SESSION_TYPES],
    description: 'See get_block.sessionTypes for what each one means and which count as quality or as volume.',
  },
  title: { type: 'string', maxLength: 120, description: 'What the athlete reads on the card. Spanish.' },
  notes: {
    type: ['string', 'null'],
    maxLength: 2000,
    description:
      'Coaching prose only — terrain, cadence, what to abort on. Never the numbers: the workout goes in `steps`. Spanish.',
  },
  steps: STEPS_SCHEMA,
  targetDistanceM: {
    type: ['number', 'null'],
    description: 'Metres. Leave it out when `steps` are given — it is derived from them.',
  },
  targetDurationS: {
    type: ['integer', 'null'],
    description: 'Seconds. For sessions measured in time rather than distance: strength, cross-training, cycling.',
  },
  targetPaceLo: paceString('Faster bound of the pace band, mm:ss per km, e.g. "3:50".'),
  targetPaceHi: paceString('Slower bound of the pace band, mm:ss per km, e.g. "3:58".'),
  doneAt: {
    type: ['string', 'null'],
    pattern: '^\\d{4}-\\d{2}-\\d{2}$',
    description:
      'Ticks the session off by hand, YYYY-MM-DD. Only for sessions Strava never reports (strength, cross): a run is matched to an activity on read and needs no tick.',
  },
  activityId: {
    type: ['integer', 'null'],
    description: 'Pins this session to one Strava activity, overriding the read-time match when it guesses wrong.',
  },
} as const

const SESSION_ID = {
  type: 'string',
  maxLength: 64,
  description:
    'A stable id you choose, e.g. "w03-tue-1". Writing the same id again overwrites that session, which is what makes re-running a plan safe. Omit it and a UUID is generated, and the call is no longer idempotent.',
} as const

// ---------------------------------------------------------------------------
// The registry
// ---------------------------------------------------------------------------

interface Tool extends ToolDefinition {
  run(ctx: McpCtx, args: Record<string, unknown>, now: number): Promise<unknown>
}

const TOOLS: Tool[] = [
  {
    name: 'get_block',
    title: 'Block brief',
    description:
      'CALL THIS FIRST. The brief needed to write anything: race name and date, block start and end, how many weeks it has, the goal time and goal pace, the six pace bands with their zone numbers and labels, the session types with their meta (which are quality days, which count as running volume), the step and recovery vocabulary, and today\'s date and week index. Reads nothing you have to page through — one call is enough to write a correct plan. Takes no arguments.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    // Reads nothing: every field is a constant out of `config.ts`, `block.ts` and
    // `paces.ts`, which is also what makes the brief testable without a database.
    // `wallClockNow` because "today" is a day-scale question and `Date.now()` is the one
    // number in the app that is a true instant: asked at half past midnight in Madrid,
    // the raw instant answers with yesterday's date and yesterday's week index.
    run: async (ctx, _args, now) => blockBrief(ctx, wallClockNow(now)),
  },

  {
    name: 'list_weeks',
    title: 'List weeks',
    description:
      'Every week of the block in order: its Monday and Sunday as ISO dates, its phase, focus, target volume (metres), down-week flag and notes, the volume its sessions actually prescribe, and what was actually run in it. A week with no plan_weeks row yet comes back with null fields rather than being omitted, so this is the whole block whether or not it has been written. `prescribedVolumeM` is what the week\'s sessions add up to and `targetVolumeM` is the figure they were sized from — keep them in agreement. Takes no arguments.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    async run(ctx) {
      const { block } = ctx
      const { plan } = await readBlock(ctx)
      return { totalWeeks: totalWeeks(block), weeks: plan.map((week) => weekOut(block, week)) }
    },
  },

  {
    name: 'list_sessions',
    title: 'List sessions',
    description:
      'The prescribed sessions, newest last. Filter by `weekIndex`, or by an ISO date range with `from` / `to` (both inclusive); with no filter it returns the whole plan, which for a 23-week block is a few hundred rows. Each session carries its structured `steps`, its targets (metres, seconds, mm:ss paces) and whether it is done — either ticked off by hand or satisfied by a matching activity, resolved exactly as the app resolves it. Call list_activities for what was actually run.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        weekIndex: { type: 'integer', minimum: 0, description: '0-based week of the block. Overrides from/to.' },
        from: isoDate('Earliest scheduled day, inclusive, YYYY-MM-DD.'),
        to: isoDate('Latest scheduled day, inclusive, YYYY-MM-DD.'),
      },
    },
    async run(ctx, args) {
      const { db, userId, block } = ctx
      const { sessions, matched } = await readBlock(ctx)

      let from: number | undefined
      let to: number | undefined
      if (args.weekIndex !== undefined) {
        const index = readWeekIndex(block, args.weekIndex)
        from = weekStart(block, index)
        to = from + 6 * DAY_MS
      } else {
        from = readIsoArg(args, 'from')
        to = readIsoArg(args, 'to')
      }

      const rows = sessions.filter(
        (s) => (from === undefined || s.scheduledOn >= from) && (to === undefined || s.scheduledOn <= to),
      )
      return { count: rows.length, sessions: rows.map((s) => sessionOut(block, s, matched.get(s.id))) }
    },
  },

  {
    name: 'list_activities',
    title: 'List activities',
    description:
      'What was actually run, synced from Strava — the record a plan should be adapted to. Filter by ISO date range with `from` / `to` (both inclusive). Distances are metres, moving time seconds, pace mm:ss per km, cadence steps per minute. Heart rate is reported as its zone (1–5), never as beats: the number drifts with heat, sleep and the strap and nothing in this plan is decided on it. `load` is Strava\'s Relative Effort where the strap recorded one and an estimate otherwise. This tool does not write anything and cannot trigger a sync.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        from: isoDate('Earliest day, inclusive, YYYY-MM-DD.'),
        to: isoDate('Latest day, inclusive, YYYY-MM-DD.'),
        limit: { type: 'integer', minimum: 1, maximum: 500, description: 'Most recent N within the range. Default 200.' },
      },
    },
    async run(ctx, args) {
      const { db, userId, block, hrMax } = ctx
      const from = readIsoArg(args, 'from')
      const to = readIsoArg(args, 'to')
      const limit = args.limit === undefined ? 200 : readWithin(args.limit, 1, 500, 'limit')

      // Only the date narrowing goes in the array. The athlete filter stays written out at
      // the query below, where it is visible to a reader and to the tenancy test — a
      // `where(and(...filters))` that happens to contain it somewhere is exactly the shape
      // that hid `update_session` being unscoped.
      const narrow: SQL[] = [gte(activities.startedOn, from ?? block.startsOn)]
      if (to !== undefined) narrow.push(lte(activities.startedOn, to))

      const rows = await db
        .select()
        .from(activities)
        .where(and(eq(activities.userId, userId), ...narrow))
        .orderBy(asc(activities.startedOn))

      const kept = rows.slice(Math.max(0, rows.length - limit))
      return { count: kept.length, truncated: rows.length > kept.length, activities: kept.map((a) => activityOut(a, hrMax)) }
    },
  },

  {
    name: 'get_training_summary',
    title: 'Training summary',
    description:
      'The derived picture over a window, for deciding how hard the next weeks can ramp: weekly running volume, the 42-day fitness and 7-day fatigue averages with the form they leave, consistency (runs per week, days run, longest gap, breaks of six days or more), best efforts over 5K/10K/15K/half and the half-marathon time they project to, and where the running time went by heart-rate zone. `weeklyVolume` and `bestEfforts` cover the whole block rather than the window — a week bar and a personal best are facts about the season. Defaults to the last 28 days ending today; pass `from` / `to` for another window. Reuses the app\'s own analytics, so these numbers are the ones on the athlete\'s screens. A few derived labels come back in the app\'s Spanish; every key and number is English.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        from: isoDate('Start of the window, inclusive, YYYY-MM-DD. Default: 27 days before `to`.'),
        to: isoDate('End of the window, inclusive, YYYY-MM-DD. Default: today.'),
      },
    },
    async run(ctx, args, now) {
      const { db, userId, block, hrMax } = ctx
      const to = readIsoArg(args, 'to') ?? startOfDay(wallClockNow(now))
      const from = readIsoArg(args, 'from') ?? to - 27 * DAY_MS
      if (from > to) throw new ToolError('`from` is after `to`.')

      const rows = await db
        .select()
        .from(activities)
        .where(and(eq(activities.userId, userId), gte(activities.startedOn, block.startsOn)))

      // `summarise` takes the whole list and windows it itself — the activities *before*
      // the window are the run-in a 42-day average needs to mean anything, and dropping
      // them would open the fitness curve at zero and read six weeks of catching up as
      // six weeks of progress.
      const window = summarise(rows, from, to)
      const inWindow = rows.filter(
        (activity) => startOfDay(activity.startedOn) >= window.from && startOfDay(activity.startedOn) <= window.to,
      )
      const point = fitnessSeries(rows, to, to).at(-1)
      // Bests are read from the whole block, not the window: a personal best is a fact
      // about the season, and a four-week window would report the fastest easy month.
      const efforts = bestEfforts(block, rows, hrMax)
      const projection = projectHalf(efforts, block.raceDistanceM)

      return {
        window: { from: toIsoDate(window.from), to: toIsoDate(window.to), weeks: round(window.weeks, 2) },
        totals: {
          runs: window.totals.runs,
          distanceM: round(window.totals.distanceM),
          movingS: window.totals.movingS,
          elevationM: round(window.totals.elevationM),
          longestM: round(window.totals.longestM),
          meanPace: window.totals.meanPaceSKm == null ? null : toPace(window.totals.meanPaceSKm),
          meanCadenceSpm: window.totals.meanCadenceSpm == null ? null : round(window.totals.meanCadenceSpm),
        },
        distancePerWeekM: round(window.distancePerWeekM),
        consistency: {
          runsPerWeek: round(window.consistency.runsPerWeek, 2),
          daysRun: window.consistency.daysRun,
          days: window.consistency.days,
          longestGapDays: window.consistency.longestGapDays,
          breaks: window.consistency.breaks,
          rate: round(window.consistency.rate, 3),
        },
        load: {
          total: round(window.load),
          estimatedShare: round(window.estimated, 3),
        },
        fitness: {
          fitness: round(point?.fitness ?? 0, 1),
          fatigue: round(point?.fatigue ?? 0, 1),
          form: round(point?.form ?? 0, 1),
          label: formLabel(point?.form ?? 0).label,
        },
        weeklyVolume: weeklyTotals(block, rows, totalWeeks(block)).flatMap((totals, index) =>
          totals === null
            ? []
            : [
                {
                  weekIndex: index,
                  startsOn: toIsoDate(weekStart(block, index)),
                  runs: totals.runs,
                  distanceM: round(totals.distanceM),
                  meanPace: totals.meanPaceSKm == null ? null : toPace(totals.meanPaceSKm),
                },
              ],
        ),
        bestEfforts: efforts.map((effort) => ({
          label: effort.label,
          distanceM: effort.distanceM,
          pace: effort.paceSKm == null ? null : toPace(effort.paceSKm),
          time: effort.timeS == null ? null : formatClock(effort.timeS),
          activityId: effort.activity?.id ?? null,
          date: effort.activity ? toIsoDate(effort.activity.startedOn) : null,
        })),
        projectedHalf:
          projection === null
            ? null
            : { time: formatClock(projection.timeS), timeS: round(projection.timeS), from: projection.from.label },
        hrZones: {
          coverage: round(zoneCoverage(inWindow), 3),
          shares: zoneShares(inWindow, hrMax).map((share) => ({
            zone: share.zone,
            runs: share.runs,
            movingS: share.movingS,
            distanceM: round(share.distanceM),
          })),
        },
      }
    },
  },

  {
    name: 'upsert_week',
    title: 'Write a week',
    description:
      'Creates or updates one week of the block: phase, focus, target volume (metres), down-week flag, notes. Write the weeks before the sessions — the week is the layer the plan is steered from, and a session scheduled into a week with no phase has nothing to be consistent with. An absent field is left alone; an explicit null clears it. `weekIndex` is 0-based from the block start; see get_block for how many weeks there are.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['weekIndex'],
      properties: {
        weekIndex: { type: 'integer', minimum: 0, description: '0-based week of the block.' },
        phase: { type: ['string', 'null'], maxLength: 60, description: 'Free text, e.g. "Base". Spanish.' },
        focus: { type: ['string', 'null'], maxLength: 200, description: 'What this week is for, in a line. Spanish.' },
        targetVolumeM: { type: ['number', 'null'], description: 'Running volume target, metres.' },
        isDownWeek: { type: 'boolean', description: 'A recovery week — lower volume, quality kept.' },
        notes: { type: ['string', 'null'], maxLength: 2000, description: 'Coaching prose. Spanish.' },
      },
    },
    async run(ctx, args, now) {
      const { db, userId, block } = ctx
      const index = readWeekIndex(block, args.weekIndex)
      const { weekIndex: _ignored, ...rest } = args

      const parsed = updateWeekInput.safeParse(rest)
      if (!parsed.success) {
        throw new ToolError(
          'The week is not valid; nothing was written.',
          parsed.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
        )
      }

      const patch = { ...parsed.data, updatedAt: now }
      const [row] = await db
        .insert(planWeeks)
        .values({ userId, weekIndex: index, ...patch })
        .onConflictDoUpdate({ target: [planWeeks.userId, planWeeks.weekIndex], set: patch })
        .returning()

      return weekShape(block, index, row ?? null)
    },
  },

  {
    name: 'create_session',
    title: 'Create a session',
    description:
      'Adds one session to the plan. Use create_sessions for a whole week or a whole plan — this is for a single addition. Dates are YYYY-MM-DD and must fall inside the block; distances are metres, durations seconds, paces mm:ss per km. Express the workout as `steps`, not as prose in `notes`. Pass a stable `id` to make the call idempotent. Returns the written row.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['scheduledOn', 'type', 'title'],
      properties: { id: SESSION_ID, ...SESSION_FIELDS },
    },
    async run(ctx, args, now) {
      const { db, userId, block } = ctx
      const id = readId(args.id)
      const parsed = parseSession(args, sessionInputs(block).createSessionInput)
      if ('issues' in parsed) throw new ToolError('The session is not valid; nothing was written.', parsed.issues)

      await assertOwnsActivities(ctx, [parsed.data as { activityId?: number | null }])

      const [row] = await db
        .insert(planSessions)
        .values({ userId, id, ...withDerivedDistance(parsed.data, ctx.bands), updatedAt: now } as NewPlanSession)
        // The key is (user_id, id), so the conflict target has to be both. Naming `id`
        // alone matches no constraint and D1 rejects the statement outright — which is at
        // least loud. The dangerous version of this mistake is the one that *matches*: an
        // upsert keyed on `id` across all athletes would let one agent's `w03-tue-1`
        // overwrite another's.
        .onConflictDoUpdate({
          target: [planSessions.userId, planSessions.id],
          set: excludedSet(planSessions, ['userId', 'id']),
        })
        .returning()

      return row ? sessionOut(block, row) : { id }
    },
  },

  {
    name: 'create_sessions',
    title: 'Create sessions in bulk',
    description:
      'Writes many sessions in one call — a whole week, or a whole plan. This is the tool that makes "write me a 16-week plan" one round trip instead of ninety. Every row is validated before any of them is written: if one fails, nothing is written and the error names the failing rows by their index in the array. Give each row a stable `id` (e.g. "w03-tue-1") so re-running the call rewrites those sessions instead of duplicating them; ids must be unique within the batch. Same field types as create_session.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['sessions'],
      properties: {
        sessions: {
          type: 'array',
          minItems: 1,
          maxItems: 400,
          description: 'The sessions to write, in any order.',
          items: {
            type: 'object',
            required: ['scheduledOn', 'type', 'title'],
            properties: { id: SESSION_ID, ...SESSION_FIELDS },
          },
        },
      },
    },
    async run(ctx, args, now) {
      const { db, userId, block } = ctx
      const list = args.sessions
      if (!Array.isArray(list) || list.length === 0) throw new ToolError('`sessions` must be a non-empty array.')

      const rows: NewPlanSession[] = []
      const failures: { index: number; issues: Issue[] }[] = []
      const seen = new Set<string>()

      list.forEach((raw, index) => {
        if (!isRecord(raw)) {
          failures.push({ index, issues: [{ path: '', message: 'expected an object' }] })
          return
        }

        let id: string
        try {
          id = readId(raw.id)
        } catch (cause) {
          failures.push({ index, issues: [{ path: 'id', message: (cause as Error).message }] })
          return
        }
        if (seen.has(id)) {
          failures.push({ index, issues: [{ path: 'id', message: `duplicate id "${id}" in this batch` }] })
          return
        }
        seen.add(id)

        const parsed = parseSession(raw, sessionInputs(block).createSessionInput)
        if ('issues' in parsed) failures.push({ index, issues: parsed.issues })
        else rows.push({ userId, id, ...withDerivedDistance(parsed.data, ctx.bands), updatedAt: now } as NewPlanSession)
      })

      if (failures.length > 0) {
        throw new ToolError(
          `${failures.length} of ${list.length} sessions are not valid; nothing was written.`,
          failures,
        )
      }

      await assertOwnsActivities(ctx, rows as { activityId?: number | null }[])

      const perStatement = chunkSize(planSessions)
      const statements = []
      for (let i = 0; i < rows.length; i += perStatement) {
        statements.push(
          db
            .insert(planSessions)
            .values(rows.slice(i, i + perStatement))
            .onConflictDoUpdate({
              target: [planSessions.userId, planSessions.id],
              set: excludedSet(planSessions, ['userId', 'id']),
            }),
        )
      }
      await db.batch(statements as [(typeof statements)[number], ...typeof statements])

      return {
        written: rows.length,
        statements: statements.length,
        rowsPerStatement: perStatement,
        ids: rows.map((row) => row.id),
      }
    },
  },

  {
    name: 'update_session',
    title: 'Update a session',
    description:
      'Patches one session by id. An absent field is left alone; an explicit null clears it — which is how "remove the pace target" differs from "leave the pace target". This does NOT recompute anything: changing targetDistanceM by hand leaves any existing `steps` in place, so if the breakdown no longer matches, pass `steps: null` in the same call or rewrite them. Moving a session to another day is just a new `scheduledOn`; its week follows the date.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['id'],
      properties: {
        id: { type: 'string', description: 'The session id, from list_sessions.' },
        ...SESSION_FIELDS,
      },
    },
    async run(ctx, args, now) {
      const { db, userId, block } = ctx
      const id = args.id
      if (typeof id !== 'string' || id === '') throw new ToolError('`id` is required.')

      const parsed = parseSession(args, sessionInputs(block).updateSessionInput)
      if ('issues' in parsed) throw new ToolError('The patch is not valid; nothing was written.', parsed.issues)

      // `and(userId, id)`, because `id` alone is not a key here: the primary key is
      // (user_id, id), and ids are hand-chosen slugs like `w03-tue-1` that two athletes
      // will pick independently. Scoped by the *where clause* rather than by a read-then-
      // check, so there is no window between the two and no row that is looked at before
      // it is established whose it is.
      await assertOwnsActivities(ctx, [parsed.data as { activityId?: number | null }])

      const [row] = await db
        .update(planSessions)
        .set({ ...withDerivedDistance(parsed.data, ctx.bands), updatedAt: now })
        .where(and(eq(planSessions.userId, userId), eq(planSessions.id, id)))
        .returning()

      if (!row) throw new ToolError(`No session with id "${id}".`)
      return sessionOut(block, row)
    },
  },

  {
    name: 'delete_session',
    title: 'Delete a session',
    description:
      'Removes one session by id. Permanent, and it takes the session\'s workout with it. Deleting a session does not touch the week\'s targetVolumeM — call upsert_week if the week total should change with it.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['id'],
      properties: { id: { type: 'string', description: 'The session id, from list_sessions.' } },
    },
    async run(ctx, args) {
      const { db, userId, block } = ctx
      const id = args.id
      if (typeof id !== 'string' || id === '') throw new ToolError('`id` is required.')

      const [row] = await db
        .delete(planSessions)
        .where(and(eq(planSessions.userId, userId), eq(planSessions.id, id)))
        .returning({ id: planSessions.id })

      if (!row) throw new ToolError(`No session with id "${id}".`)
      return { deleted: row.id }
    },
  },
]

function readWithin(raw: unknown, min: number, max: number, label: string): number {
  if (!Number.isInteger(raw) || (raw as number) < min || (raw as number) > max) {
    throw new ToolError(`${label} must be an integer between ${min} and ${max}.`)
  }
  return raw as number
}

/** What the reader is told before it picks a tool. */
export const SERVER_INSTRUCTIONS = `This server is your own training block: a fixed window of weeks ending on race day, the plan prescribed inside it, and the activities synced from Strava.

To author or revise a plan:
1. Call get_block first. It gives the block's dates, how many weeks it has, the goal time and pace, the pace bands, the session types and the step vocabulary. Everything you write has to fit inside those dates.
2. Call list_weeks to see what is already written and what has actually been run. Call get_training_summary before deciding how hard the next weeks may ramp.
3. Write the weeks with upsert_week before you write any sessions into them.
4. Write the sessions with create_sessions — a whole week or the whole plan in one call. create_session is for a single addition.

Rules the plan has to respect:
- Express a workout as structured steps, never as prose in notes. Steps are what let the app count repetitions, fold recovery jogs into the week's volume and know the pace of a rep. notes is for coaching prose only: terrain, cadence, what to abort on.
- Never put two quality sessions (tempo, interval, fartlek, race) on consecutive days, and never more than three in a week.
- A week's real volume is what its sessions add up to. Keep the week's targetVolumeM and the sessions you write for it in agreement, and ramp it by roughly 10% a week with a down week every third or fourth.
- Give every session a stable id, so running the same call again rewrites the plan instead of duplicating it.
- Distances are metres, durations seconds, dates YYYY-MM-DD, paces mm:ss per kilometre.

The app speaks Spanish to the athlete. Tool names, arguments and these instructions are English because you are the reader — but a session's title and notes are read by a person, so write those in Spanish.`

/**
 * The MCP surface's own version, bumped when a tool's contract changes. Deliberately not
 * the app's package version, which moves for reasons no client cares about.
 */
export const SERVER_VERSION = '2.1.0'

/**
 * Binds the tools to a database and a credential.
 *
 * The context arrives as an argument rather than being read from `cloudflare:workers`
 * here, which is what keeps this module out of the bindings and testable in plain Node —
 * `src/pages/api/mcp.ts` is the only file that knows where `env.DB` comes from.
 *
 * One registry per request, built *after* the bearer token has been resolved to an
 * athlete, so every tool it hands back is already bound to that athlete's rows. There is
 * no registry that is not somebody's.
 */
export function createToolRegistry(ctx: McpCtx): ToolRegistry {
  const byName = new Map(TOOLS.map((tool) => [tool.name, tool]))

  return {
    list: () => TOOLS.map(({ name, title, description, inputSchema }) => ({ name, title, description, inputSchema })),

    async call(name, args): Promise<ToolResult> {
      const tool = byName.get(name)
      if (!tool) throw new ToolError(`Unknown tool "${name}".`)

      try {
        // The true instant, which is what `updatedAt` wants; the two tools that ask
        // "what day is it" move it onto the wall clock themselves.
        const value = await tool.run(ctx, args, Date.now())
        return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] }
      } catch (cause) {
        // A validation failure is a result the agent can act on, not a dead transport:
        // the details say which row and which field, so it can fix them and call again.
        const message = cause instanceof Error ? cause.message : String(cause)
        const details = cause instanceof ToolError && cause.details !== undefined
          ? `\n${JSON.stringify(cause.details, null, 2)}`
          : ''
        return { content: [{ type: 'text', text: `${message}${details}` }], isError: true }
      }
    },
  }
}
