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
  workoutTemplates,
  type Activity,
  type NewPlanSession,
  type PlanSession,
  type PlanWeek,
} from '../db/schema'
import {
  BODY_PARTS,
  CATEGORIES,
  EQUIPMENT,
  MAX_RESULTS,
  MUSCLES,
  TAGS,
  DEFAULT_RESULTS,
  exerciseById,
  searchExercises,
  unknownExerciseIds,
  type CatalogExercise,
} from '../exercises/catalog'
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
import { createTemplateInput, sessionInputs, updateTemplateInput, updateWeekInput } from '../plan-input'
import {
  PRESCRIPTION_KINDS,
  SESSION_META,
  SESSION_TYPES,
  buildBlock,
  type MatchedSession,
  type SessionType,
  type WeekPlan,
} from '../plan'
import {
  STRATEGIES,
  formatPrescription,
  prescriptionOf,
  type PrescriptionKind,
  type StoredPrescription,
} from '../prescription'
import {
  BUILTIN_PREFIX,
  BUILTIN_TEMPLATES,
  builtInTemplate,
  isBuiltInTemplateId,
  sessionFromTemplate,
  type TemplateContent,
} from '../starters'
import { RECOVERY_KINDS, STEP_KINDS, type Bands } from '../workout'
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
  const prescription = prescriptionOf(session.steps)
  return {
    id: session.id,
    date: toIsoDate(session.scheduledOn),
    weekIndex: weekIndex(block, session.scheduledOn),
    dayOrder: session.dayOrder,
    type: session.type,
    isQuality: SESSION_META[session.type].isQuality,
    title: session.title,
    notes: session.notes,
    /** The column as stored: a bare array for a run, a tagged object for anything else. */
    steps: session.steps,
    /**
     * The prescription as the app renders it — Spanish, because that is the app's own
     * prose, and dispatched on the tag so a strength day reads as its list of moves rather
     * than as nothing at all.
     *
     * `formatPrescription` is left on its default bands, which are the *owner's*, exactly
     * as `formatWorkout` was here before. It is an oddity worth naming rather than
     * quietly correcting to `ctx.bands`: this line is the one place in the MCP surface
     * that renders a pace it did not derive, and changing it would move every agent's
     * `workout` string on a surface whose whole contract is that it does not drift.
     */
    workout: prescription ? formatPrescription(prescription) : null,
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
      place: block.racePlace,
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
      /** Which shape this type's `steps` carries — see `prescriptions` below. */
      prescribes: SESSION_META[type].prescribes,
      countsAsVolume: SESSION_META[type].countsAsVolume,
      isQuality: SESSION_META[type].isQuality,
    })),
    /**
     * What each kind of prescription is made of, assembled from the strategies rather than
     * described a second time here. That is what makes a new kind of prescription cost the
     * MCP server no edit at all: it declares its own `authoring.brief` beside its model and
     * appears in this map the moment it is registered.
     */
    prescriptions: Object.fromEntries(
      PRESCRIPTION_KINDS.map((kind) => [kind, STRATEGIES[kind].authoring.brief]),
    ) as Record<PrescriptionKind, Record<string, unknown>>,
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
 * What a session's prescription writes into its derived columns.
 *
 * `targetDistanceM` is the column every screen sums and the one the activity matcher
 * measures against, and this boundary is the write time — a session written here without
 * it is invisible to the week bars and unmatchable to a run. Derived with the athlete's
 * own bands so a timed step is costed at their paces, never the owner's table. An explicit
 * `steps: null` leaves a hand-set distance alone, which is what keeps update_session's two
 * documented modes — "change the number, drop the steps" and "rewrite the steps" — both
 * true.
 *
 * The name is now half a lie and is kept anyway: the *distance* is what the run strategy
 * derives, and a strength prescription derives nothing at all (its minutes are stated on
 * the session, not computed from a list of planks). Renaming it would rewrite a
 * six-assertion test whose value is that it has not changed — so the dispatch moved
 * inside and the signature did not move at all.
 */
export function withDerivedDistance(
  data: Record<string, unknown>,
  bands: Bands,
): Record<string, unknown> {
  const prescription = prescriptionOf(data.steps as StoredPrescription | null | undefined)
  if (!prescription) return data

  // Resolved here rather than read inside the strategy, so `prescription.ts` never has to
  // import `plan.ts` — the module graph runs the other way.
  const type = data.type as SessionType | undefined
  const countsAsVolume = type ? SESSION_META[type].countsAsVolume : true

  const targets = STRATEGIES[prescription.kind].deriveTargets(
    prescription as never,
    bands,
    countsAsVolume,
  )
  return Object.keys(targets).length > 0 ? { ...data, ...targets } : data
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

/** Every table this module upserts into. All three are keyed `(user_id, …)`. */
type UpsertTable = typeof planWeeks | typeof planSessions | typeof workoutTemplates

const columnsOf = (table: UpsertTable) => Object.keys(getTableColumns(table)).length

/**
 * Rows per statement, derived from the column count rather than hardcoded, so a column
 * added to the schema cannot silently push a statement over D1's limit. Same derivation as
 * `src/lib/sync.ts`.
 */
const chunkSize = (table: UpsertTable) =>
  Math.max(1, Math.floor(D1_MAX_BOUND_PARAMS / columnsOf(table)))

/**
 * Every column but the key ones, so an upsert overwrites rather than skipping.
 *
 * `userId` is always among them: the keys here are composite — `(user_id, week_index)` and
 * `(user_id, id)` — and a SET that reassigns the owner of a row on conflict is a sentence
 * nobody should ever be able to write by accident.
 */
const excludedSet = (table: UpsertTable, keys: string[]) =>
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
// The exercise catalogue and the template library
// ---------------------------------------------------------------------------

/**
 * A catalogue row as a search hit — the twelve fields that decide whether this is the move
 * the agent wants, and none of the prose that answers how to do it. That is `get_exercise`,
 * one call away, and keeping the two apart is what lets a search return fifty rows without
 * returning fifty paragraphs.
 *
 * `tags` is in here deliberately, unlike the HTTP surface's trimmed row: the agent reasons
 * about `knee_safe` and `no_axial_load` while the picker renders a chip, and a tag it has
 * to make a second call to see is a tag it will not filter on.
 */
const exerciseOut = (exercise: CatalogExercise) => ({
  id: exercise.id,
  name: exercise.name,
  nameEn: exercise.nameEn,
  category: exercise.category,
  bodyPart: exercise.bodyPart,
  difficulty: exercise.difficulty,
  equipment: exercise.equipment,
  isUnilateral: exercise.isUnilateral,
  tags: exercise.tags,
})

/**
 * A template on the way out. `builtIn` is the only field that is not on the row, and it is
 * what tells an agent which two of these it may not write to — they ship in code and have
 * no rows, so `update_template` on one is a mistake worth naming rather than a 404.
 */
const templateOut = (template: TemplateContent, builtIn = false) => ({
  id: template.id,
  name: template.name,
  notes: template.notes,
  targetDurationS: template.targetDurationS,
  exercises: template.exercises,
  builtIn,
})

/** A facet value has to be one the catalogue actually uses, or the answer is a silent zero. */
function readFacet(
  args: Record<string, unknown>,
  key: string,
  allowed: readonly string[],
): string | undefined {
  const raw = args[key]
  if (raw === undefined || raw === null) return undefined
  if (typeof raw !== 'string' || !allowed.includes(raw)) {
    // An unknown facet returning an empty list reads as "there is no such exercise", which
    // is the wrong conclusion to hand a model. The valid values ride along so it can fix
    // the call rather than abandon the approach.
    throw new ToolError(`"${String(raw)}" is not a known ${key}.`, { [key]: [...allowed] })
  }
  return raw
}

/**
 * The ids in a prescription the catalogue does not know, as issues an agent can act on.
 *
 * Returned rather than thrown, because `create_sessions` has to collect one of these per
 * failing row before it refuses the batch — the same reason `parseSession` returns issues.
 * `unknownExerciseIds` already skips a null id: a move the catalogue does not have is a
 * legitimate prescription, not a typo.
 */
const exerciseIssues = (
  entries: readonly { exerciseId: string | null }[],
  pathPrefix: string,
): Issue[] =>
  unknownExerciseIds(entries).map(({ index, exerciseId }) => ({
    path: `${pathPrefix}.${index}.exerciseId`,
    message: `"${exerciseId}" is not a catalogue id; search_exercises returns the ones that are. Use null for a move the catalogue does not have.`,
  }))

/** The same question asked of a session's `steps`, which only sometimes prescribes exercises. */
function sessionExerciseIssues(steps: unknown): Issue[] {
  const prescription = prescriptionOf(steps as StoredPrescription | null | undefined)
  return prescription?.kind === 'strength'
    ? exerciseIssues(prescription.exercises, 'steps.exercises')
    : []
}

/**
 * A template id an agent may choose — `readId`'s slug rules, plus the one namespace that
 * is not theirs to write in.
 *
 * The built-ins have no rows, so an id starting `treximo-` would not collide with anything
 * and would quietly work: the athlete would end up with a private template shadowing a
 * built-in in every list that merges the two. Refusing it up front is cheaper than
 * explaining that afterwards.
 */
function readNewTemplateId(raw: unknown): string {
  const id = readId(raw)
  if (isBuiltInTemplateId(id)) {
    throw new ToolError(
      `Ids beginning "${BUILTIN_PREFIX}" belong to the templates that ship with the app. Copy one under an id of your own instead — list_templates returns their exercises.`,
    )
  }
  return id
}

/** The id of a template that must already exist, and must be the athlete's own. */
function readOwnTemplateId(raw: unknown): string {
  if (typeof raw !== 'string' || raw === '') throw new ToolError('`id` is required.')
  if (isBuiltInTemplateId(raw)) {
    throw new ToolError(
      `"${raw}" ships with the app and has no row to change. Copy its exercises into a template of your own with create_template.`,
    )
  }
  return raw
}

/**
 * One of the athlete's templates by id, or `null`.
 *
 * `and(userId, id)` because `id` alone is not a key: the primary key is `(user_id, id)` and
 * a template id is a hand-chosen slug like `fuerza-lunes` that two athletes will pick
 * independently. Scoped by the where clause, never by a read-then-check.
 */
async function readTemplate({ db, userId }: McpCtx, id: string): Promise<TemplateContent | null> {
  const [row] = await db
    .select()
    .from(workoutTemplates)
    .where(and(eq(workoutTemplates.userId, userId), eq(workoutTemplates.id, id)))
    .limit(1)

  return row ?? null
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

/**
 * `steps` holds a *prescription*, and there is more than one shape of one.
 *
 * The arms are not written here. Each kind declares its own JSON Schema next to its own
 * model — the running one in `prescription.ts`, the strength one in `strength.ts` — and
 * this assembles the `oneOf` from the registry, in `PRESCRIPTION_KINDS` order. That is the
 * whole reason the arms moved: a kind added to the union appears in this schema, in the
 * brief and in every reader without `tools.ts` being edited at all. The array arm's prose
 * is unchanged word for word from when it lived here, so an agent built against the old
 * revision reads the same sentences it always did.
 *
 * The sentence below names no kind for the same reason, and it used to: "a strength or
 * mobility session is the tagged object beside it" was a hand-written list under an `oneOf`
 * that assembles itself, so a third kind would have compiled, rendered and then described
 * itself wrongly to every agent reading the schema. It points at `get_block.prescriptions`
 * instead, which is the registry's own answer to the same question.
 */
const STEPS_SCHEMA = {
  type: ['array', 'object', 'null'],
  description:
    'What the session prescribes. A running workout is the array of steps described below; every other kind is a tagged object, and the tag is what tells them apart. See get_block.prescriptions for the kinds, and get_block.sessionTypes[].prescribes for which types take which. Pass null to clear an existing prescription.',
  oneOf: PRESCRIPTION_KINDS.map((kind) => STRATEGIES[kind].authoring.schema),
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

/**
 * A template's `exercises` are a strength prescription's `exercises` — the same entries,
 * validated by the same zod schema — so they are described by the same JSON Schema rather
 * than by a second copy of sixty lines of prose that would drift on the first field added.
 *
 * The cast is the seam. `authoring.schema` is typed as opaque JSON Schema because the
 * registry cannot know what shape each kind's arm has; this is the one place that does, and
 * it is deliberately the only place that reaches inside one.
 */
const TEMPLATE_EXERCISES = (
  STRATEGIES.strength.authoring.schema as {
    properties: { exercises: Record<string, unknown> }
  }
).properties.exercises

/** The two types a template can be stamped onto. Attaching planks to a tempo day is a typo. */
const TEMPLATE_SESSION_TYPES = ['strength', 'cross'] as const

const TEMPLATE_FIELDS = {
  name: {
    type: 'string',
    maxLength: 120,
    description: 'What the athlete reads in the library and what the session is titled when this is applied. Spanish.',
  },
  notes: {
    type: ['string', 'null'],
    maxLength: 2000,
    description:
      'Coaching prose for the whole block — cuándo progresar, qué señales respetar. It is copied onto the session too. Spanish.',
  },
  exercises: TEMPLATE_EXERCISES,
  targetDurationS: {
    type: ['integer', 'null'],
    description:
      'How long the whole thing takes, in seconds. A strength day is measured in minutes and never in metres, and nothing derives this from the exercises — state it.',
  },
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
      'CALL THIS FIRST. The brief needed to write anything: race name, place and date, block start and end, how many weeks it has, the goal time and goal pace, the six pace bands with their zone numbers and labels, the session types with their meta (which are quality days, which count as running volume), the step and recovery vocabulary, and today\'s date and week index. Reads nothing you have to page through — one call is enough to write a correct plan. Takes no arguments.',
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

      // zod knows the shape of a strength prescription; only the catalogue knows whether
      // the ids in it are real, and it is not in `plan-input.ts` because that would drag
      // 630 KB of vendored prose into every session write.
      const unknown = sessionExerciseIssues(parsed.data.steps)
      if (unknown.length > 0) throw new ToolError('The session is not valid; nothing was written.', unknown)

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
        if ('issues' in parsed) {
          failures.push({ index, issues: parsed.issues })
          return
        }

        // Collected rather than thrown, so one mistyped exercise id in row 40 is reported
        // beside every other bad row instead of hiding them.
        const unknown = sessionExerciseIssues(parsed.data.steps)
        if (unknown.length > 0) {
          failures.push({ index, issues: unknown })
          return
        }

        rows.push({ userId, id, ...withDerivedDistance(parsed.data, ctx.bands), updatedAt: now } as NewPlanSession)
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

      const unknown = sessionExerciseIssues(parsed.data.steps)
      if (unknown.length > 0) throw new ToolError('The patch is not valid; nothing was written.', unknown)

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

  {
    name: 'search_exercises',
    title: 'Search exercises',
    description:
      'Finds moves in the vendored exercise catalogue — the vocabulary a strength or mobility prescription is written from. Query in Spanish or in English: both names are indexed, along with the slug, and accents, case and hyphens are ignored, so "side plank" and "plancha lateral" both find the same row. Leave `q` out and pass a facet to browse instead. Prefer the knee_safe and no_axial_load tags when the athlete has reported knee trouble, and equipment "none" unless they have said what they own. Returns at most 50 ranked rows and has no cursor, so this is a search, not a listing: narrow it rather than paging. Call get_exercise for the instructions and the coaching cues. The Spanish `name` on a row is what a prescription must carry — copy it rather than translating it yourself.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        q: {
          type: 'string',
          maxLength: 80,
          description: 'Free text over the Spanish name, the English name and the slug.',
        },
        muscle: {
          type: 'string',
          enum: [...MUSCLES],
          description: 'Matches a primary or a secondary muscle — "what does this work" is not a strict question.',
        },
        equipment: {
          type: 'string',
          enum: [...EQUIPMENT, 'none'],
          description: '"none" means bodyweight only, which is not the same as leaving this out (that means "any").',
        },
        tags: {
          type: 'array',
          maxItems: 6,
          items: { type: 'string', enum: [...TAGS] },
          description: 'Every tag must be present. knee_safe, no_axial_load and mobility are the ones a rebuild cares about.',
        },
        bodyPart: { type: 'string', enum: [...BODY_PARTS], description: 'The region the move belongs to.' },
        category: { type: 'string', enum: [...CATEGORIES], description: 'What kind of move it is.' },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: MAX_RESULTS,
          description: `How many rows to return, 1 to ${MAX_RESULTS}. Default ${DEFAULT_RESULTS}.`,
        },
      },
    },
    async run(_ctx, args) {
      if (args.q !== undefined && args.q !== null && typeof args.q !== 'string') {
        throw new ToolError('`q` must be a string.')
      }
      // "none" is the one facet value that is not a catalogue value: bodyweight is the
      // absence of equipment, so it is a different filter rather than another slug.
      const equipment = readFacet(args, 'equipment', [...EQUIPMENT, 'none'])

      const results = searchExercises({
        q: typeof args.q === 'string' ? args.q : undefined,
        muscle: readFacet(args, 'muscle', MUSCLES),
        equipment: equipment === 'none' ? undefined : equipment,
        bodyweightOnly: equipment === 'none',
        bodyPart: readFacet(args, 'bodyPart', BODY_PARTS),
        category: readFacet(args, 'category', CATEGORIES),
        tags: readTags(args.tags),
        limit: args.limit === undefined ? undefined : readWithin(args.limit, 1, MAX_RESULTS, 'limit'),
      })

      return { count: results.length, results: results.map(exerciseOut) }
    },
  },

  {
    name: 'get_exercise',
    title: 'Get one exercise',
    description:
      'The whole record for one catalogue exercise: what it is, how it is done step by step, the coaching tips, the muscles it works, its tags and which illustrations exist for it. All the prose is Spanish, because it is the athlete\'s. Call this before prescribing a move you are not certain of — an exercise chosen from a name alone is how a rebuild acquires an injury vector.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['id'],
      properties: { id: { type: 'string', description: 'The catalogue id, from search_exercises.' } },
    },
    async run(_ctx, args) {
      const exercise = typeof args.id === 'string' ? exerciseById(args.id) : undefined
      if (!exercise) {
        throw new ToolError(`No exercise with id "${String(args.id)}". search_exercises returns the ids that exist.`)
      }
      return exercise
    },
  },

  {
    name: 'list_templates',
    title: 'List templates',
    description:
      'The athlete\'s reusable strength and mobility templates, with their exercises inline, followed by the ones that ship with the app (flagged `builtIn`). A template is a session without a day: applying one copies its content onto a session, so it is the thing to write once and attach eleven times rather than typing the same nine moves into every Monday. This is also the read — there is no get_template. The built-in ones cannot be updated or deleted; copy their exercises into a template of your own instead. Takes no arguments.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    async run(ctx) {
      const { db, userId } = ctx
      const rows = await db
        .select()
        .from(workoutTemplates)
        .where(eq(workoutTemplates.userId, userId))
        .orderBy(asc(workoutTemplates.name))

      return {
        count: rows.length + BUILTIN_TEMPLATES.length,
        templates: [
          ...rows.map((row) => templateOut(row)),
          // Merged server-side rather than left to the client, so the agent sees exactly
          // the library the athlete sees. They ship in code and have no rows.
          ...BUILTIN_TEMPLATES.map((template) => templateOut(template, true)),
        ],
      }
    },
  },

  {
    name: 'create_template',
    title: 'Create a template',
    description:
      'Writes one reusable strength or mobility template. Pass a stable `id` (e.g. "fuerza-lunes") and writing it again rewrites that template instead of leaving a second copy — the same idempotency create_session has, and for the same reason. A template carries no date, which is the whole point: attach_template is what puts it on a day. Everything the athlete reads — the name, every exercise name, the load and every note — is Spanish. Ids beginning "treximo-" are reserved for the templates that ship with the app.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['name', 'exercises'],
      properties: {
        id: {
          type: 'string',
          maxLength: 64,
          description:
            'A stable id you choose. Writing the same id again overwrites that template. Omit it and a UUID is generated, and the call is no longer idempotent.',
        },
        ...TEMPLATE_FIELDS,
      },
    },
    async run(ctx, args, now) {
      const { db, userId } = ctx
      const id = readNewTemplateId(args.id)
      const { id: _ignored, ...rest } = args

      const parsed = createTemplateInput.safeParse(rest)
      if (!parsed.success) {
        throw new ToolError(
          'The template is not valid; nothing was written.',
          parsed.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
        )
      }

      const unknown = exerciseIssues(parsed.data.exercises, 'exercises')
      if (unknown.length > 0) throw new ToolError('The template is not valid; nothing was written.', unknown)

      const [row] = await db
        .insert(workoutTemplates)
        .values({ userId, id, ...parsed.data, updatedAt: now })
        // The key is (user_id, id), so the conflict target has to be both — a target of
        // `id` alone across all athletes would let one agent's `fuerza-lunes` overwrite
        // another's. Same rule, same reasoning, as create_session's.
        .onConflictDoUpdate({
          target: [workoutTemplates.userId, workoutTemplates.id],
          set: excludedSet(workoutTemplates, ['userId', 'id']),
        })
        .returning()

      return row ? templateOut(row) : { id }
    },
  },

  {
    name: 'update_template',
    title: 'Update a template',
    description:
      'Patches one template by id. An absent field is left alone; an explicit null clears it. `exercises` is the exception and replaces the whole list: an entry has no identity of its own, so there is nothing for a partial update to address — send the list you want, in the order you want it. Sessions already stamped from this template are NOT changed: they carry a copy, so a revision here reaches the next attachment and nothing that is already written.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['id'],
      properties: {
        id: { type: 'string', description: 'The template id, from list_templates.' },
        ...TEMPLATE_FIELDS,
      },
    },
    async run(ctx, args, now) {
      const { db, userId } = ctx
      const id = readOwnTemplateId(args.id)
      const { id: _ignored, ...patch } = args

      const parsed = updateTemplateInput.safeParse(patch)
      if (!parsed.success) {
        throw new ToolError(
          'The patch is not valid; nothing was written.',
          parsed.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
        )
      }

      const unknown = parsed.data.exercises ? exerciseIssues(parsed.data.exercises, 'exercises') : []
      if (unknown.length > 0) throw new ToolError('The patch is not valid; nothing was written.', unknown)

      const [row] = await db
        .update(workoutTemplates)
        .set({ ...parsed.data, updatedAt: now })
        .where(and(eq(workoutTemplates.userId, userId), eq(workoutTemplates.id, id)))
        .returning()

      if (!row) throw new ToolError(`No template with id "${id}".`)
      return templateOut(row)
    },
  },

  {
    name: 'delete_template',
    title: 'Delete a template',
    description:
      'Removes one template from the library. Permanent, and it takes its exercises with it. Sessions already stamped from it are untouched — they carry a copy, so deleting the library entry cannot blank a Monday that has already been trained. The templates that ship with the app cannot be deleted.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['id'],
      properties: { id: { type: 'string', description: 'The template id, from list_templates.' } },
    },
    async run(ctx, args) {
      const { db, userId } = ctx
      const id = readOwnTemplateId(args.id)

      const [row] = await db
        .delete(workoutTemplates)
        .where(and(eq(workoutTemplates.userId, userId), eq(workoutTemplates.id, id)))
        .returning({ id: workoutTemplates.id })

      if (!row) throw new ToolError(`No template with id "${id}".`)
      return { deleted: row.id }
    },
  },

  {
    name: 'attach_template',
    title: 'Apply a template to a day',
    description:
      'Puts a template on a day — the one call that turns a library entry into prescribed training. Pass `scheduledOn` to create the session, or `sessionId` to stamp one that already exists; exactly one of the two. The session gets a COPY of the template: its name becomes the title, its notes and duration come across, and its exercises become the session\'s prescription. Editing the template afterwards never rewrites a session already written, which is the point — a Monday that has been trained is a record, not a view. `dayOrder` is 0 for a strength day that stands on its own and 1 for a block that rides on the same day as a run. Built-in templates (ids beginning "treximo-") attach exactly like your own.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['templateId'],
      properties: {
        templateId: { type: 'string', description: 'The template to copy, from list_templates.' },
        scheduledOn: isoDate('The day to create the session on, YYYY-MM-DD. Must fall inside the block. Pass this or sessionId.'),
        sessionId: {
          type: 'string',
          description: 'An existing session to stamp instead, from list_sessions. Pass this or scheduledOn.',
        },
        id: {
          type: 'string',
          maxLength: 64,
          description:
            'Only with scheduledOn: a stable id for the session being created, e.g. "w03-mon-0", so re-running the call rewrites it rather than adding a second one.',
        },
        dayOrder: {
          type: 'integer',
          minimum: 0,
          maximum: 9,
          description: 'Orders sessions within one day. 0 for a strength day on its own, 1 for one that rides on a run.',
        },
        type: {
          type: 'string',
          enum: [...TEMPLATE_SESSION_TYPES],
          description: 'Defaults to "strength" when creating; left alone when stamping an existing session.',
        },
      },
    },
    async run(ctx, args, now) {
      const { db, userId, block } = ctx
      if (typeof args.templateId !== 'string' || args.templateId === '') {
        throw new ToolError('`templateId` is required; list_templates has the ids.')
      }

      const onDay = args.scheduledOn !== undefined && args.scheduledOn !== null
      const ontoSession = args.sessionId !== undefined && args.sessionId !== null
      if (onDay === ontoSession) {
        throw new ToolError(
          'Pass exactly one of `scheduledOn`, to create the session, or `sessionId`, to stamp one that already exists.',
        )
      }

      // Built-ins first: they ship in code and have no row, so the scoped read below would
      // answer "no such template" for an id the athlete can see in their own library.
      const template = builtInTemplate(args.templateId) ?? (await readTemplate(ctx, args.templateId))
      if (!template) {
        throw new ToolError(
          `No template with id "${args.templateId}". list_templates returns yours and the built-in ones.`,
        )
      }

      // The copy. Deliberately not re-checked against the catalogue: these entries were
      // checked when the template was written, and a catalogue re-vendored since must cost
      // the athlete an illustration, never the use of their own template.
      const content = sessionFromTemplate(template)
      const type = args.type === undefined ? undefined : readTemplateSessionType(args.type)

      if (ontoSession) {
        const sessionId = args.sessionId
        if (typeof sessionId !== 'string' || sessionId === '') {
          throw new ToolError('`sessionId` must be the id of an existing session.')
        }

        const patch = {
          ...content,
          ...(type === undefined ? {} : { type }),
          ...(args.dayOrder === undefined ? {} : { dayOrder: args.dayOrder }),
        }
        const parsed = parseSession(patch, sessionInputs(block).updateSessionInput)
        if ('issues' in parsed) throw new ToolError('The session is not valid; nothing was written.', parsed.issues)

        const [stamped] = await db
          .update(planSessions)
          .set({ ...withDerivedDistance(parsed.data, ctx.bands), updatedAt: now })
          .where(and(eq(planSessions.userId, userId), eq(planSessions.id, sessionId)))
          .returning()

        if (!stamped) throw new ToolError(`No session with id "${sessionId}".`)
        return sessionOut(block, stamped)
      }

      const id = readId(args.id)
      const fields = {
        scheduledOn: args.scheduledOn,
        type: type ?? 'strength',
        ...(args.dayOrder === undefined ? {} : { dayOrder: args.dayOrder }),
        ...content,
      }
      const parsed = parseSession(fields, sessionInputs(block).createSessionInput)
      if ('issues' in parsed) throw new ToolError('The session is not valid; nothing was written.', parsed.issues)

      const [row] = await db
        .insert(planSessions)
        .values({ userId, id, ...withDerivedDistance(parsed.data, ctx.bands), updatedAt: now } as NewPlanSession)
        .onConflictDoUpdate({
          target: [planSessions.userId, planSessions.id],
          set: excludedSet(planSessions, ['userId', 'id']),
        })
        .returning()

      return row ? sessionOut(block, row) : { id }
    },
  },
]

function readWithin(raw: unknown, min: number, max: number, label: string): number {
  if (!Number.isInteger(raw) || (raw as number) < min || (raw as number) > max) {
    throw new ToolError(`${label} must be an integer between ${min} and ${max}.`)
  }
  return raw as number
}

function readTags(raw: unknown): string[] | undefined {
  if (raw === undefined || raw === null) return undefined
  if (!Array.isArray(raw)) throw new ToolError('`tags` must be an array of tag names.', { tags: [...TAGS] })
  for (const tag of raw) {
    if (typeof tag !== 'string' || !TAGS.includes(tag)) {
      throw new ToolError(`"${String(tag)}" is not a known tag.`, { tags: [...TAGS] })
    }
  }
  return raw as string[]
}

/**
 * A template describes what is done, never when — so the day decides whether it lands as a
 * strength session or a cross-training one, and those are the only two it may land as.
 * Stamping a template onto a `tempo` day would replace a workout with a list of planks and
 * leave the card still calling itself a quality session.
 */
function readTemplateSessionType(raw: unknown): (typeof TEMPLATE_SESSION_TYPES)[number] {
  if (typeof raw !== 'string' || !TEMPLATE_SESSION_TYPES.includes(raw as 'strength' | 'cross')) {
    throw new ToolError(`"${String(raw)}" is not a type a template can be attached as.`, {
      type: [...TEMPLATE_SESSION_TYPES],
    })
  }
  return raw as (typeof TEMPLATE_SESSION_TYPES)[number]
}

/** What the reader is told before it picks a tool. */
export const SERVER_INSTRUCTIONS = `This server is your own training block: a fixed window of weeks ending on race day, the plan prescribed inside it, and the activities synced from Strava.

To author or revise a plan:
1. Call get_block first. It gives the block's dates, how many weeks it has, the goal time and pace, the pace bands, the session types and the step vocabulary. Everything you write has to fit inside those dates.
2. Call list_weeks to see what is already written and what has actually been run. Call get_training_summary before deciding how hard the next weeks may ramp.
3. Write the weeks with upsert_week before you write any sessions into them.
4. Write the sessions with create_sessions — a whole week or the whole plan in one call. create_session is for a single addition.

To write the strength and mobility days:
5. Build them from templates rather than typing the same nine moves into eleven Mondays. search_exercises finds the moves (query in Spanish or English), get_exercise gives you the instructions, create_template writes the library entry and attach_template puts it on a day.
6. Two templates ship with the app, with ids beginning "treximo-" — list_templates returns them alongside the athlete's own. Attach one directly, or copy its exercises into a template of your own to change it; they cannot be edited in place.
7. Prefer exercises tagged knee_safe and no_axial_load when the athlete has mentioned knee trouble, and ones needing no equipment unless they have said what they own.
8. Attaching a template COPIES it onto the session. Revising the template afterwards reaches the next attachment and never a session already written — a day that has been trained is a record, not a view of the library.

Rules the plan has to respect:
- Express a workout as structured steps, never as prose in notes. Steps are what let the app count repetitions, fold recovery jogs into the week's volume and know the pace of a rep. notes is for coaching prose only: terrain, cadence, what to abort on.
- A strength or mobility session prescribes exercises rather than steps: the same steps field, carrying the tagged object described in its schema. Each entry takes repetitions or seconds, never both.
- Never put two quality sessions (tempo, interval, fartlek, race) on consecutive days, and never more than three in a week.
- A week's real volume is what its sessions add up to. Keep the week's targetVolumeM and the sessions you write for it in agreement, and ramp it by roughly 10% a week with a down week every third or fourth.
- Give every session a stable id, so running the same call again rewrites the plan instead of duplicating it.
- Distances are metres, durations seconds, dates YYYY-MM-DD, paces mm:ss per kilometre.

The app speaks Spanish to the athlete. Tool names, arguments and these instructions are English because you are the reader — but a session's title and notes are read by a person, so write those in Spanish. So are a template's name and notes, and every exercise name, load and note inside one: copy the Spanish name the catalogue gives you rather than translating the English one yourself.`

/**
 * The MCP surface's own version, bumped when a tool's contract changes. Deliberately not
 * the app's package version, which moves for reasons no client cares about.
 */
export const SERVER_VERSION = '2.2.0'

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
