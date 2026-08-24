import { decimal } from './format'
import { PACES, ZONE_LABEL, midPaceSKm, type PaceBand, type PaceZone } from './paces'

/**
 * The prescription itself — what a session actually asks for, as data rather than prose.
 *
 * `plan_sessions.notes` used to carry "5 × 1 km @ 3:50, 90s jog" as a string, which reads
 * fine and computes nothing: the reps could not be counted, the recovery could not be
 * added to the week's volume, and the pace of a rep was invisible to everything except
 * the eye. A session is a short list of steps instead, so the same row answers "how many
 * repetitions", "at what pace", "how long is the jog" and "how far is the whole thing".
 *
 * Pure and browser-safe — no drizzle, no zod, no clock. `db/schema.ts` imports `Step`
 * from here; the zod mirror lives in `plan-input.ts`, which only the Worker loads.
 */

export type StepKind = 'warmup' | 'rep' | 'steady' | 'strides' | 'cooldown'
export const STEP_KINDS: [StepKind, ...StepKind[]] = [
  'warmup',
  'rep',
  'steady',
  'strides',
  'cooldown',
]

/** `float` is the easy running between fartlek surges; `jog` the slower one between reps. */
export type RecoveryKind = 'jog' | 'float' | 'walk' | 'standing'
export const RECOVERY_KINDS: [RecoveryKind, ...RecoveryKind[]] = [
  'jog',
  'float',
  'walk',
  'standing',
]

export interface Recovery {
  kind: RecoveryKind
  /** Measured by distance… */
  distanceM: number | null
  /** …or by time. Exactly one of the two is set. */
  durationS: number | null
}

export interface Step {
  kind: StepKind
  /** How many times the effort repeats. 1 for everything that is not a rep set. */
  reps: number
  distanceM: number | null
  durationS: number | null
  /** `null` means "by feel" — Phase 0 runs carry no pace band on purpose. */
  zone: PaceZone | null
  /** Between reps, so a set of `reps` has `reps - 1` of them. `null` when reps is 1. */
  recovery: Recovery | null
  note: string | null
}

/** Recovery jogs are costed at the slow end of easy — they are not part of the workout. */
const JOG_PACE_S_KM = PACES.easy.hi
const WALK_PACE_S_KM = 12 * 60
/** Strides are ~5 m/s: fast, relaxed turnover, not a sprint. */
const STRIDE_SPEED_MS = 5
const DEFAULT_STRIDE_S = 20

/** Zones that count as quality when measuring how much of a week is run hard. */
const HARD_ZONES = new Set<PaceZone>(['threshold', 'race', 'vo2'])

const make = (kind: StepKind, patch: Partial<Step>): Step => ({
  kind,
  reps: 1,
  distanceM: null,
  durationS: null,
  zone: null,
  recovery: null,
  note: null,
  ...patch,
})

// Builders. The seed reads as the workout does — `reps(5, km(1), 'vo2', jogFor(90))`.
export const km = (value: number) => Math.round(value * 1000)

export const warmup = (distanceM: number, zone: PaceZone | null = 'easy') =>
  make('warmup', { distanceM, zone })

export const cooldown = (distanceM: number, zone: PaceZone | null = 'easy') =>
  make('cooldown', { distanceM, zone })

export const steady = (distanceM: number, zone: PaceZone | null, note?: string) =>
  make('steady', { distanceM, zone, note: note ?? null })

export const forMinutes = (minutes: number, zone: PaceZone | null, note?: string) =>
  make('steady', { durationS: Math.round(minutes * 60), zone, note: note ?? null })

export const reps = (
  count: number,
  each: { distanceM?: number; durationS?: number },
  zone: PaceZone | null,
  recovery: Recovery | null,
  note?: string,
) =>
  make('rep', {
    reps: count,
    distanceM: each.distanceM ?? null,
    durationS: each.durationS ?? null,
    zone,
    recovery,
    note: note ?? null,
  })

export const strides = (count: number, seconds = DEFAULT_STRIDE_S, note?: string) =>
  make('strides', { reps: count, durationS: seconds, note: note ?? null })

export const jogFor = (seconds: number): Recovery => ({
  kind: 'jog',
  distanceM: null,
  durationS: seconds,
})
export const jogOver = (distanceM: number): Recovery => ({
  kind: 'jog',
  distanceM,
  durationS: null,
})
export const floatFor = (seconds: number): Recovery => ({
  kind: 'float',
  distanceM: null,
  durationS: seconds,
})
export const standingFor = (seconds: number): Recovery => ({
  kind: 'standing',
  distanceM: null,
  durationS: seconds,
})

function recoveryDistanceM(recovery: Recovery): number {
  if (recovery.distanceM != null) return recovery.distanceM
  if (recovery.durationS == null) return 0
  switch (recovery.kind) {
    case 'standing':
      return 0
    case 'walk':
      return (recovery.durationS / WALK_PACE_S_KM) * 1000
    default:
      return (recovery.durationS / JOG_PACE_S_KM) * 1000
  }
}

function recoveryDurationS(recovery: Recovery): number {
  if (recovery.durationS != null) return recovery.durationS
  if (recovery.distanceM == null) return 0
  const pace = recovery.kind === 'walk' ? WALK_PACE_S_KM : JOG_PACE_S_KM
  return (recovery.distanceM / 1000) * pace
}

/** One rep's distance — its own, or what its duration buys at the zone's mid-pace. */
function effortDistanceM(step: Step): number {
  if (step.kind === 'strides') return (step.durationS ?? DEFAULT_STRIDE_S) * STRIDE_SPEED_MS
  if (step.distanceM != null) return step.distanceM
  if (step.durationS == null) return 0
  // A timed effort with no band is costed as easy running — the fallback only ever
  // applies to Phase 0, where the whole point is that there is no band.
  return (step.durationS / midPaceSKm(step.zone ?? 'easy')) * 1000
}

function effortDurationS(step: Step): number {
  if (step.durationS != null) return step.durationS
  if (step.kind === 'strides') return DEFAULT_STRIDE_S
  if (step.distanceM == null) return 0
  return (step.distanceM / 1000) * midPaceSKm(step.zone ?? 'easy')
}

/** The step's own running, recoveries excluded — `5 × 1 km` is 5 km however long the jog. */
export const effortMetres = (step: Step) => effortDistanceM(step) * step.reps

/** Everything the step puts on the legs, recovery jogs included. */
export function stepDistanceM(step: Step): number {
  const recoveries = step.recovery ? recoveryDistanceM(step.recovery) * (step.reps - 1) : 0
  return effortDistanceM(step) * step.reps + recoveries
}

export function stepDurationS(step: Step): number {
  const recoveries = step.recovery ? recoveryDurationS(step.recovery) * (step.reps - 1) : 0
  return effortDurationS(step) * step.reps + recoveries
}

/** Total prescribed distance, metres. This is what a session's target distance is. */
export const workoutDistanceM = (steps: Step[]) =>
  Math.round(steps.reduce((sum, step) => sum + stepDistanceM(step), 0))

/** Estimated time on feet, seconds — derived, never stored, always shown as ≈. */
export const workoutDurationS = (steps: Step[]) =>
  Math.round(steps.reduce((sum, step) => sum + stepDurationS(step), 0))

/**
 * Metres run at threshold or faster — the honest measure of a week's intensity.
 *
 * Warm-ups, cool-downs and recovery jogs are excluded, which is why this is not simply
 * the distance of the quality sessions: an interval session is mostly easy running.
 */
export const hardDistanceM = (steps: Step[]) =>
  Math.round(
    steps
      .filter((s) => (s.kind === 'rep' || s.kind === 'steady') && s.zone && HARD_ZONES.has(s.zone))
      .reduce((sum, s) => sum + effortDistanceM(s) * s.reps, 0),
  )

/** The band the session is really about — the widest effort that is not a warm-up. */
export function primaryZone(steps: Step[]): PaceZone | null {
  let best: PaceZone | null = null
  let bestM = 0
  for (const step of steps) {
    if (step.kind === 'warmup' || step.kind === 'cooldown' || !step.zone) continue
    const metres = effortDistanceM(step) * step.reps
    if (metres > bestM) {
      best = step.zone
      bestM = metres
    }
  }
  return best
}

/** The band that zone is run at — what a session prescribes when nothing overrides it. */
export const workoutBand = (steps: Step[]): PaceBand | null => {
  const zone = primaryZone(steps)
  return zone ? PACES[zone] : null
}

// ---------------------------------------------------------------------------
// Formatting. Kept beside the model so the card, the row and the week summary
// all say a rep set the same way.
// ---------------------------------------------------------------------------

/** `400 m`, `1 km`, `12,5 km` — metres below a kilometre, kilometres above it. */
export function formatDistance(metres: number): string {
  if (metres < 1000) return `${Math.round(metres / 10) * 10} m`
  const value = metres / 1000
  return `${Number.isInteger(value) ? value : decimal(value)} km`
}

/** `45 s`, `90 s`, `12 min` — seconds until they stop being how a runner says it. */
export function formatSeconds(seconds: number): string {
  if (seconds < 120) return `${Math.round(seconds)} s`
  const minutes = seconds / 60
  return `${Number.isInteger(minutes) ? minutes : decimal(minutes)} min`
}

/** What one repetition is measured in — `1 km`, `8 min`, `20 s`. */
export const stepAmount = (step: Step): string =>
  step.distanceM != null
    ? formatDistance(step.distanceM)
    : step.durationS != null
      ? formatSeconds(step.durationS)
      : ''

/**
 * What the step is *for*, in one word.
 *
 * `stepHeadline` folds the role into the phrase ("3 km de calentamiento"), which is what a
 * one-line summary wants. The detail view stacks instead — the amount on its own line, big
 * enough to read at arm's length, and the role under it beside the pace — so it needs the
 * word on its own. `steady` is `Continuo` because that is what a block with no repetitions
 * is called in the club: carrera continua, whatever pace it is run at.
 */
export const STEP_ROLE: Record<StepKind, string> = {
  warmup: 'Calentamiento',
  rep: 'Serie',
  steady: 'Continuo',
  strides: 'Progresiones',
  cooldown: 'Vuelta a la calma',
}

/** The step without its pace or recovery — `5 × 1 km`, `3 km de calentamiento`. */
export function stepHeadline(step: Step): string {
  if (step.kind === 'strides') {
    return `${step.reps} progresiones de ${formatSeconds(step.durationS ?? DEFAULT_STRIDE_S)}`
  }
  const size = stepAmount(step)
  if (step.kind === 'warmup') return `${size} de calentamiento`
  if (step.kind === 'cooldown') return `${size} de vuelta a la calma`
  return step.reps > 1 ? `${step.reps} × ${size}` : size
}

const band = (zone: PaceZone | null) => {
  if (!zone) return null
  const { lo, hi } = PACES[zone]
  const mmss = (s: number) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`
  return lo === hi ? `${mmss(lo)}/km` : `${mmss(lo)}–${mmss(hi)}/km`
}

/** How each kind of recovery is said — `90 s de trote`, `1 km andando`, `60 s parado`. */
const RECOVERY_WORD: Record<RecoveryKind, string> = {
  jog: 'de trote',
  float: 'de trote suave',
  walk: 'andando',
  standing: 'parado',
}

export function formatRecovery(recovery: Recovery): string {
  const size =
    recovery.distanceM != null
      ? formatDistance(recovery.distanceM)
      : formatSeconds(recovery.durationS ?? 0)
  return `${size} ${RECOVERY_WORD[recovery.kind]}`
}

/** `5 × 1 km @ 3:50–3:58 · 90 s de trote` — one step, said the way a session is written. */
export function formatStep(step: Step): string {
  const headline = stepHeadline(step)
  if (step.kind === 'strides' || step.kind === 'warmup' || step.kind === 'cooldown') return headline

  const pace = band(step.zone)
  const withPace = pace ? `${headline} @ ${pace}` : headline
  return step.recovery && step.reps > 1
    ? `${withPace} · ${formatRecovery(step.recovery)}`
    : withPace
}

/** Whether the step is the workout itself, rather than the running around it. */
export const isEffort = (step: Step) =>
  step.kind === 'rep' || step.kind === 'steady' || step.kind === 'strides'

/** The whole session on one line, for the row that has no space to expand. */
export const formatWorkout = (steps: Step[]) => steps.map(formatStep).join(' · ')

/**
 * What the plan says where it prescribes no band at all.
 *
 * Phase 0 is written that way on purpose — docs/03 §4, "ignore all of these and run easy
 * by feel" — so a session with no zone is not a session missing its pace. One constant, so
 * the card, the breakdown and the detail view all say the absence the same way instead of
 * each rendering a different kind of nothing.
 */
export const BY_FEEL = 'A sensaciones'

export const zoneLabel = (zone: PaceZone | null) => (zone ? ZONE_LABEL[zone] : BY_FEEL)
export const paceBandLabel = band
