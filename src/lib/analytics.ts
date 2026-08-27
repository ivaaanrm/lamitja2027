import { DAY_MS, WEEK_MS, goalPaceSKm, startOfDay, weekIndex, type BlockConfig } from './block'
import { isRun, paceSKm } from './activity'
import { totals, type Totals } from './metrics'
import { PACES, hrZone, paceBands, type Zone } from './paces'
import type { Activity } from './db/schema'

/**
 * Read-time analytics over a list of activities — the layer the trend pages are drawn
 * from. Pure, browser-safe and clock-free: every entry point takes its window explicitly,
 * so "the last 28 days" means the same thing in a test as it does on a phone at midnight.
 *
 * Everything here works on `Activity[]` and nothing else, which is what lets this season
 * and last season run through identical code — `baseline.ts` shifts the 2025-26 rows onto
 * this block's calendar, and from here they are just activities.
 *
 * Nothing is stored. Two seasons is ~250 rows; the whole page recomputes in under a
 * millisecond, and a rollup table would be a second copy of the truth to keep honest.
 *
 * What is athlete-specific here is what a *judgement* is made against: whether a run was
 * an effort, and which zone a heart rate falls in. Those take the block and the athlete's
 * maximum heart rate. The load model below deliberately does not — see its own note.
 */

// ---------------------------------------------------------------------------
// Training load
// ---------------------------------------------------------------------------

/**
 * 5:15/km — the middle of the easy band, and the anchor the load fallback is scaled to.
 *
 * It stays the owner's band for every athlete on purpose: `LOAD_K` and `LOAD_EXPONENT`
 * below were solved *with this anchor held fixed*, so re-anchoring it per athlete would
 * silently invalidate the fit rather than transfer it. The curve it feeds is an
 * exponential average of itself — relative, self-consistent within one athlete's season,
 * and never quoted as a number — so a constant scale factor between athletes costs
 * nothing the app reads.
 */
const EASY_MID_S_KM = (PACES.easy.lo + PACES.easy.hi) / 2

/**
 * Strava's Relative Effort is heart-rate derived, so it cannot be recovered from distance
 * and time. These two constants are a least-squares fit of `k · minutes · (easy/pace)^n`
 * over the 100 runs in `docs/personal/data` that carry one: it lands within ~33% on average, which
 * is close enough to keep a 42-day average pointing the right way and nowhere near close
 * enough to quote as a number.
 *
 * It only ever applies to a run recorded without a heart-rate strap. `estimatedShare`
 * reports how much of a window leaned on it so the UI can say so.
 */
const LOAD_K = 0.96
const LOAD_EXPONENT = 4.2

/** True when this activity's load had to be guessed rather than read from Strava. */
const loadIsEstimated = (activity: Activity) => activity.sufferScore == null

/** One activity's training load — Relative Effort where Strava recorded it. */
export function activityLoad(activity: Activity): number {
  if (activity.sufferScore != null) return activity.sufferScore
  if (activity.movingS <= 0) return 0

  const minutes = activity.movingS / 60
  if (!isRun(activity.sportType) || activity.distanceM <= 0) {
    // Rides and hikes without a strap: costed as easy running of the same duration, which
    // is what the knee protocol uses them for in the first place.
    return LOAD_K * minutes
  }
  const intensity = EASY_MID_S_KM / paceSKm(activity.distanceM, activity.movingS)
  return LOAD_K * minutes * Math.pow(intensity, LOAD_EXPONENT)
}

/** The share of a window's load that came from the fallback rather than from Strava. */
export function estimatedShare(activities: Activity[]): number {
  let estimated = 0
  let total = 0
  for (const activity of activities) {
    const load = activityLoad(activity)
    total += load
    if (loadIsEstimated(activity)) estimated += load
  }
  return total === 0 ? 0 : estimated / total
}

// ---------------------------------------------------------------------------
// Day axes
// ---------------------------------------------------------------------------

/** Every local midnight from `from` to `to`, inclusive. The x-axis every series shares. */
export function days(from: number, to: number): number[] {
  const first = startOfDay(from)
  const last = startOfDay(to)
  const count = Math.max(0, Math.round((last - first) / DAY_MS) + 1)
  return Array.from({ length: count }, (_, i) => first + i * DAY_MS)
}

function loadByDay(activities: Activity[]): Map<number, number> {
  const byDay = new Map<number, number>()
  for (const activity of activities) {
    const day = startOfDay(activity.startedOn)
    byDay.set(day, (byDay.get(day) ?? 0) + activityLoad(activity))
  }
  return byDay
}

// ---------------------------------------------------------------------------
// Fitness, fatigue, form
// ---------------------------------------------------------------------------

/** Time constants, days. The impulse-response pair every training-load model uses. */
const FITNESS_DAYS = 42
const FATIGUE_DAYS = 7

export interface FitnessPoint {
  date: number
  /** 42-day exponentially weighted load. Strava calls it Fitness; the literature, CTL. */
  fitness: number
  /** 7-day. Fatigue, or ATL. */
  fatigue: number
  /** Fitness minus fatigue *as of yesterday* — what today is being started on. */
  form: number
}

/**
 * The fitness curve over `[from, to]`, run in from every activity given.
 *
 * The run-in is the whole reason `PRE_BLOCK` exists: a 42-day average opened at zero on
 * day one climbs for six weeks whatever the athlete does, and that climb would read as
 * progress rather than as an average catching up with a life already in motion.
 */
export function fitnessSeries(activities: Activity[], from: number, to: number): FitnessPoint[] {
  if (activities.length === 0) return []
  const byDay = loadByDay(activities)
  const start = Math.min(startOfDay(from), ...[...byDay.keys()])

  let fitness = 0
  let fatigue = 0
  const series: FitnessPoint[] = []

  for (const date of days(start, to)) {
    const yesterdayForm = fitness - fatigue
    const load = byDay.get(date) ?? 0
    fitness += (load - fitness) / FITNESS_DAYS
    fatigue += (load - fatigue) / FATIGUE_DAYS
    if (date >= startOfDay(from)) series.push({ date, fitness, fatigue, form: yesterdayForm })
  }

  return series
}

/** How the day's form reads. The bands are Strava's, rounded. */
export function formLabel(form: number): { label: string; tone: 'good' | 'warn' | 'flat' } {
  if (form < -30) return { label: 'Sobrecarga', tone: 'warn' }
  if (form < -10) return { label: 'Construyendo', tone: 'good' }
  if (form <= 5) return { label: 'Estable', tone: 'flat' }
  if (form <= 25) return { label: 'Fresco', tone: 'good' }
  return { label: 'Desentrenando', tone: 'warn' }
}

// ---------------------------------------------------------------------------
// Series
// ---------------------------------------------------------------------------

/**
 * Cumulative running metres by day, aligned to `days(from, to)`.
 *
 * `null` before the first activity, so a season that started later starts later on the
 * chart instead of tracing a flat line along zero it never actually ran.
 */
export function cumulativeByDay(
  activities: Activity[],
  from: number,
  to: number,
): (number | null)[] {
  const runs = activities.filter((a) => isRun(a.sportType))
  if (runs.length === 0) return days(from, to).map(() => null)

  const byDay = new Map<number, number>()
  for (const run of runs) {
    const day = startOfDay(run.startedOn)
    byDay.set(day, (byDay.get(day) ?? 0) + run.distanceM)
  }
  const opens = Math.min(...runs.map((r) => startOfDay(r.startedOn)))

  let sum = 0
  return days(from, to).map((date) => {
    sum += byDay.get(date) ?? 0
    return date < opens ? null : sum
  })
}

/**
 * Running totals per block week, `null` outside the weeks the data actually covers.
 *
 * The distinction matters for the baseline: week 1 of this block has no counterpart in a
 * 20-week season, and drawing that as a zero would invent a week off that never happened.
 */
export function weeklyTotals(
  block: BlockConfig,
  activities: Activity[],
  totalWeeks: number,
): (Totals | null)[] {
  const byWeek = new Map<number, Activity[]>()
  for (const activity of activities) {
    const week = weekIndex(block, activity.startedOn)
    const bucket = byWeek.get(week)
    if (bucket) bucket.push(activity)
    else byWeek.set(week, [activity])
  }

  const covered = [...byWeek.keys()].filter((w) => w >= 0 && w < totalWeeks)
  if (covered.length === 0) return Array.from({ length: totalWeeks }, () => null)
  const first = Math.min(...covered)
  const last = Math.max(...covered)

  return Array.from({ length: totalWeeks }, (_, week) =>
    week < first || week > last ? null : totals(byWeek.get(week) ?? []),
  )
}

// ---------------------------------------------------------------------------
// Best efforts and what they project to
// ---------------------------------------------------------------------------

/** The distances worth a personal best. `docs/03` measures the goal against the 10K. */
const BENCHMARKS = [
  { distanceM: 5000, label: '5K' },
  { distanceM: 10_000, label: '10K' },
  { distanceM: 15_000, label: '15K' },
  { distanceM: 21_097.5, label: 'Media' },
] as const

export interface BestEffort {
  distanceM: number
  label: string
  /** Best average pace over a complete run of at least this distance, s/km. */
  paceSKm: number | null
  /** What that pace would carry over the benchmark itself, seconds. */
  timeS: number | null
  activity: Activity | null
}

/**
 * The pace an effort has to beat: the slow end of *this* athlete's steady band.
 *
 * Held against the owner's 4:35/km it would be a different test for everyone else —
 * nobody chasing a 1:45 half ever runs a training kilometre that fast, so no run of
 * theirs would qualify and their bests would all read as empty.
 */
const steadyCeiling = (block: BlockConfig) => paceBands(goalPaceSKm(block)).steady.hi

function isEffort(activity: Activity, hrMax: number, ceilingSKm: number): boolean {
  if (!isRun(activity.sportType) || activity.distanceM <= 0 || activity.movingS <= 0) return false
  if (activity.averageHeartrate != null && hrZone(activity.averageHeartrate, hrMax) >= 4) return true
  return paceSKm(activity.distanceM, activity.movingS) <= ceilingSKm
}

/**
 * Whether a run was an effort at all, rather than a long enough easy run.
 *
 * Without this the 10 km best would be won by whichever easy run happened to be ten
 * kilometres long — a number that says nothing, and drags the race projection down with
 * it. A run counts when the strap puts it in Z4 or above, or when it was run faster than
 * steady; either alone is enough, because the seasons in `docs/personal/data` carry no heart rate
 * and a dropout-riddled strap should not be able to disqualify a genuinely fast run.
 */
export const isEffortRun = (block: BlockConfig, activity: Activity, hrMax: number) =>
  isEffort(activity, hrMax, steadyCeiling(block))

/**
 * Bests from whole runs, not from splits.
 *
 * Strava reads best efforts out of the activity streams; this app stores summaries, so
 * "the fastest 10 km" here means "the fastest average pace over any *effort* of 10 km or
 * more". That is a slightly harder test than a 10 km split off the front of a long run,
 * and it is the same test in both seasons, which is what the comparison needs.
 */
export function bestEfforts(
  block: BlockConfig,
  activities: Activity[],
  hrMax: number,
): BestEffort[] {
  const ceiling = steadyCeiling(block)
  const runs = activities.filter((a) => isEffort(a, hrMax, ceiling))

  return BENCHMARKS.map(({ distanceM, label }) => {
    let best: Activity | null = null
    let bestPace = Infinity
    for (const run of runs) {
      if (run.distanceM < distanceM) continue
      const pace = paceSKm(run.distanceM, run.movingS)
      if (pace < bestPace) {
        best = run
        bestPace = pace
      }
    }
    return {
      distanceM,
      label,
      paceSKm: best ? bestPace : null,
      timeS: best ? (bestPace * distanceM) / 1000 : null,
      activity: best,
    }
  })
}

/** Riegel: `t₂ = t₁ · (d₂/d₁)^1.06`, the standard endurance exponent. */
export const riegel = (timeS: number, fromM: number, toM: number, exponent = 1.06) =>
  timeS * Math.pow(toM / fromM, exponent)

export interface Projection {
  /** Projected time over the race the block is built around, seconds. */
  timeS: number
  /** The effort it was projected from. */
  from: BestEffort
}

/**
 * The fastest race this season's running says is in there, over `distanceM`.
 *
 * Every benchmark is projected and the best one wins, with the effort it came from kept
 * beside it — a 5K projection and a 15K projection are very different promises, and which
 * one is talking is half the information.
 *
 * The distance is passed rather than assumed: `block.raceDistanceM` is what the screen is
 * asking about, and defaulting it to the half would answer a question nobody asked for
 * every athlete whose dorsal is a 10K.
 */
export function projectHalf(efforts: BestEffort[], distanceM: number): Projection | null {
  let best: Projection | null = null
  for (const effort of efforts) {
    if (effort.timeS == null) continue
    const timeS = riegel(effort.timeS, effort.distanceM, distanceM)
    if (!best || timeS < best.timeS) best = { timeS, from: effort }
  }
  return best
}

// ---------------------------------------------------------------------------
// Where the time actually went
// ---------------------------------------------------------------------------

export interface ZoneShare {
  zone: Zone
  movingS: number
  distanceM: number
  runs: number
}

/**
 * Running time by heart-rate zone — the check on `docs/03 §3`'s second change, that
 * frequency rises and intensity does not.
 *
 * Zones rather than paces because a pace is a lie on a hill and a zone is not, and
 * because an interval session's *average* pace is easy: bucketing whole runs by pace
 * would file the hardest session of the week under easy running. Runs without a strap are
 * left out entirely rather than guessed at — `zoneCoverage` says how much that cost.
 */
export function zoneShares(activities: Activity[], hrMax: number): ZoneShare[] {
  const byZone = new Map<Zone, ZoneShare>()
  for (const activity of activities) {
    if (!isRun(activity.sportType) || activity.averageHeartrate == null) continue
    const zone = hrZone(activity.averageHeartrate, hrMax)
    const bucket = byZone.get(zone) ?? { zone, movingS: 0, distanceM: 0, runs: 0 }
    bucket.movingS += activity.movingS
    bucket.distanceM += activity.distanceM
    bucket.runs += 1
    byZone.set(zone, bucket)
  }
  return ([1, 2, 3, 4, 5] as Zone[]).map(
    (zone) => byZone.get(zone) ?? { zone, movingS: 0, distanceM: 0, runs: 0 },
  )
}

/** The share of running time a heart rate was actually recorded for. */
export function zoneCoverage(activities: Activity[]): number {
  let withHr = 0
  let total = 0
  for (const activity of activities) {
    if (!isRun(activity.sportType)) continue
    total += activity.movingS
    if (activity.averageHeartrate != null) withHr += activity.movingS
  }
  return total === 0 ? 0 : withHr / total
}

// ---------------------------------------------------------------------------
// Consistency
// ---------------------------------------------------------------------------

/** `docs/02`'s marker: ten breaks of six days or more in seven months. */
export const BREAK_DAYS = 6

export interface Consistency {
  days: number
  runs: number
  daysRun: number
  /** Longest stretch with no run at all, including one still open at `to`. */
  longestGapDays: number
  /** How many stretches of six days or more went unrun. */
  breaks: number
  runsPerWeek: number
  /** Days run over days in the window. */
  rate: number
}

/**
 * Whether the running actually happened, week after week.
 *
 * `docs/03 §1` names consistency — not talent, not the plan — as one of the two binding
 * constraints, so it gets measured the way it failed: by the gaps, not by the totals.
 * Cross-training is not a run; a week of cycling around a sore knee is a good week and
 * still a break in running, and the knee protocol is clearer if the two are not blurred.
 */
export function consistency(activities: Activity[], from: number, to: number): Consistency {
  const first = startOfDay(from)
  const last = startOfDay(to)
  const window = Math.max(1, Math.round((last - first) / DAY_MS) + 1)

  const runDays = new Set(
    activities
      .filter((a) => isRun(a.sportType))
      .map((a) => startOfDay(a.startedOn))
      .filter((day) => day >= first && day <= last),
  )
  const runs = activities.filter(
    (a) => isRun(a.sportType) && startOfDay(a.startedOn) >= first && startOfDay(a.startedOn) <= last,
  ).length

  let gap = 0
  let longestGap = 0
  let breaks = 0
  for (const day of days(first, last)) {
    if (runDays.has(day)) {
      if (gap >= BREAK_DAYS) breaks++
      longestGap = Math.max(longestGap, gap)
      gap = 0
    } else {
      gap++
    }
  }
  // A gap still open on the last day counts — it is the one that is happening now.
  if (gap >= BREAK_DAYS) breaks++
  longestGap = Math.max(longestGap, gap)

  return {
    days: window,
    runs,
    daysRun: runDays.size,
    longestGapDays: longestGap,
    breaks,
    runsPerWeek: (runs / window) * 7,
    rate: runDays.size / window,
  }
}

// ---------------------------------------------------------------------------
// A window, summarised — the unit the two seasons are compared in
// ---------------------------------------------------------------------------

export interface WindowSummary {
  from: number
  to: number
  weeks: number
  totals: Totals
  consistency: Consistency
  /** Fitness on the last day of the window. */
  fitness: number
  /** Total training load over the window — every sport, not only running. */
  load: number
  distancePerWeekM: number
  /** `null` when nothing in the window was run without a heart-rate strap. */
  estimated: number
}

/**
 * Everything one season says about one stretch of the calendar.
 *
 * `runIn` is separate from `activities` on purpose: fitness needs six weeks of history to
 * mean anything, and that history is emphatically not part of the window being summarised.
 */
export function summarise(
  activities: Activity[],
  from: number,
  to: number,
  runIn: Activity[] = [],
): WindowSummary {
  const first = startOfDay(from)
  const last = startOfDay(to)
  const inWindow = activities.filter((a) => {
    const day = startOfDay(a.startedOn)
    return day >= first && day <= last
  })

  const curve = fitnessSeries([...runIn, ...activities], last, last)
  const weeks = Math.max(1, (last - first + DAY_MS) / WEEK_MS)
  const window = totals(inWindow)

  return {
    from: first,
    to: last,
    weeks,
    totals: window,
    consistency: consistency(activities, first, last),
    fitness: curve.at(-1)?.fitness ?? 0,
    load: inWindow.reduce((sum, a) => sum + activityLoad(a), 0),
    distancePerWeekM: window.distanceM / weeks,
    estimated: estimatedShare(inWindow),
  }
}

/** `+18%`, `−4%`, or `null` when there is nothing to divide by. */
export function percentDelta(now: number, then: number): number | null {
  if (!Number.isFinite(now) || !Number.isFinite(then) || then === 0) return null
  return (now - then) / then
}
