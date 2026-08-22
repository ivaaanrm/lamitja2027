import { BLOCK_START, DAY_MS, HALF_MARATHON_M, TOTAL_WEEKS, WEEK_MS } from './block'
import type { NewPlanSession, NewPlanWeek } from './db/schema'
import type { SessionType } from './plan'
import { PACES, type PaceZone } from './paces'

/**
 * Seeds the block from docs/03-training-plan-2027.md.
 *
 * A plain deterministic function, not an engine and not an LLM: the plan is already
 * designed in that document, and this only encodes it so the app can track execution
 * against it. Session ids are derived from week and weekday, so re-seeding after a tweak
 * updates rows in place instead of duplicating the plan — and any session edited by hand
 * afterwards is overwritten, which is the intended "reset to the plan" behaviour.
 */

/** Phase spans by 0-based week index, with the volume ramp endpoints. docs/03 §2. */
const PHASES = [
  // docs/03 was written for a 24 Aug start (22 weeks). The block actually began a week
  // earlier, on Mon 17 Aug, so it is 23 weeks — the extra week goes to rebuild, which is
  // both the phase already underway and the one where more patience is free.
  { phase: 'rebuild', from: 0, to: 6, startKm: 22, endKm: 36, focus: 'All easy. Strides only. Strength from day one.' },
  { phase: 'base', from: 7, to: 12, startKm: 40, endKm: 52, focus: '1 quality/wk. Long run 14 → 20 km.' },
  { phase: 'threshold', from: 13, to: 17, startKm: 56, endKm: 68, focus: '2 quality/wk. Tempo + long reps.' },
  { phase: 'race-specific', from: 18, to: 20, startKm: 66, endKm: 52, focus: 'Everything at 3:47/km.' },
  { phase: 'taper', from: 21, to: 22, startKm: 40, endKm: 28, focus: 'Cut volume, keep sharpness.' },
] as const

export type Phase = (typeof PHASES)[number]['phase']

/** docs/03 §2: "Down weeks at W4, W8, W12, W16, W20 (~75% volume)" — 1-based there. */
const DOWN_WEEKS = new Set([3, 7, 11, 15, 19])
const DOWN_WEEK_FACTOR = 0.75

export const isDownWeek = (week: number) => DOWN_WEEKS.has(week)

function phaseOf(week: number) {
  const phase = PHASES.find((p) => week >= p.from && week <= p.to)
  if (!phase) throw new Error(`Week ${week} is outside the ${TOTAL_WEEKS}-week block`)
  return phase
}

export const phaseFor = (week: number): Phase => phaseOf(week).phase

/**
 * Hard ceiling on week-over-week growth. docs/02 is explicit that the binding constraints
 * are the knee and consistency, not fitness, and too-fast ramping is the classic way to
 * re-injure — so this wins over the headline phase targets where they disagree.
 *
 * They do disagree in two places: docs/03's rebuild phase (22 → 36 km over six weeks)
 * implies 10.3%/wk, and the rebuild→base handover implies 11%. Both are capped here,
 * which lands the rebuild phase at ~35 km instead of 36.
 */
const MAX_WEEKLY_GROWTH = 0.1

/** The uncut ramp: linear within each phase, before down weeks and the growth cap. */
function rawRampKm(week: number): number {
  const p = phaseOf(week)
  const span = p.to - p.from
  const progress = span === 0 ? 0 : (week - p.from) / span
  return p.startKm + (p.endKm - p.startKm) * progress
}

/**
 * The ramp with the growth cap applied, computed across the whole block rather than per
 * phase so the cap also holds at phase boundaries.
 *
 * The cap is applied *before* the down-week cut, so the rebound out of a down week returns
 * to the underlying ramp rather than being throttled to +10% of the reduced week.
 */
const CAPPED_RAMP_KM: readonly number[] = (() => {
  const capped: number[] = []
  for (let week = 0; week < TOTAL_WEEKS; week++) {
    const raw = rawRampKm(week)
    if (week === 0) {
      capped.push(raw)
      continue
    }
    // Only ascending steps are capped; taper and race-specific descend on purpose.
    capped.push(Math.min(raw, capped[week - 1]! * (1 + MAX_WEEKLY_GROWTH)))
  }
  return capped
})()

/** Weekly target volume in metres, after the growth cap and the down-week cut. */
export function weeklyVolumeM(week: number): number {
  if (week < 0 || week >= TOTAL_WEEKS) {
    throw new Error(`Week ${week} is outside the ${TOTAL_WEEKS}-week block`)
  }
  const km = CAPPED_RAMP_KM[week]!
  return Math.round(km * (isDownWeek(week) ? DOWN_WEEK_FACTOR : 1) * 1000)
}

/** A slot in a week template. */
interface Slot {
  /** 0 = Monday. */
  day: number
  type: SessionType
  /** Fraction of the week's running volume. Running slots in a template sum to 1. */
  share: number
  zone?: PaceZone
  title: string
  notes?: string
  durationS?: number
}

// docs/03 §6: strength twice weekly from week one, non-negotiable. Load the hip rather
// than stretch the band — the ITB is anchored to the femur and cannot be lengthened.
const STRENGTH_NOTES =
  'Side planks w/ hip abduction · Copenhagen planks · banded lateral walks · single-leg squats · single-leg RDLs'

const STRENGTH: Slot[] = [
  { day: 0, type: 'strength', share: 0, title: 'Strength', notes: STRENGTH_NOTES, durationS: 30 * 60 },
  { day: 4, type: 'strength', share: 0, title: 'Strength', notes: `${STRENGTH_NOTES} — progressive load`, durationS: 30 * 60 },
]

/**
 * Week templates per phase. Shares are set so quality volume stays at 20–25% of weekly km
 * (docs/03 §3: "Quality density stays at 20–25% of km … and volume carries the load"),
 * and no two quality sessions land on consecutive days.
 */
const TEMPLATES: Record<Phase, Slot[]> = {
  // "In Phase 0, ignore all of these and run easy by feel" — hence no pace bands here.
  rebuild: [
    { day: 1, type: 'easy', share: 0.18, title: 'Easy run', notes: 'By feel. Flat ground, no cambered roads.' },
    { day: 2, type: 'easy', share: 0.18, title: 'Easy run', notes: 'By feel.' },
    { day: 3, type: 'easy', share: 0.18, title: 'Easy run', notes: 'By feel.' },
    { day: 5, type: 'easy', share: 0.16, title: 'Easy + strides', notes: '6 × 20s strides after the run. Metronome at 170–176 spm.' },
    { day: 6, type: 'long', share: 0.30, title: 'Long run', notes: 'Easy throughout. Flat only through this phase.' },
    ...STRENGTH,
  ],
  base: [
    { day: 1, type: 'easy', share: 0.16, zone: 'easy', title: 'Easy run' },
    { day: 2, type: 'tempo', share: 0.20, zone: 'threshold', title: 'Tempo', notes: 'Continuous at threshold after a 2 km warm-up.' },
    { day: 3, type: 'easy', share: 0.16, zone: 'easy', title: 'Easy run' },
    { day: 5, type: 'easy', share: 0.16, zone: 'easy', title: 'Easy run' },
    { day: 6, type: 'long', share: 0.32, zone: 'long', title: 'Long run' },
    ...STRENGTH,
  ],
  threshold: [
    { day: 0, type: 'easy', share: 0.10, zone: 'easy', title: 'Recovery run' },
    { day: 1, type: 'interval', share: 0.13, zone: 'vo2', title: 'Intervals', notes: '5 × 1 km, 90s jog recovery.' },
    { day: 2, type: 'easy', share: 0.15, zone: 'easy', title: 'Easy run' },
    { day: 3, type: 'easy', share: 0.15, zone: 'easy', title: 'Easy run' },
    { day: 4, type: 'tempo', share: 0.12, zone: 'threshold', title: 'Tempo' },
    { day: 5, type: 'easy', share: 0.10, zone: 'easy', title: 'Easy run' },
    { day: 6, type: 'long', share: 0.25, zone: 'long', title: 'Long run' },
  ],
  // docs/03 §3: "Race-pace long runs. None were run last block. Phase 3 is built around them."
  'race-specific': [
    { day: 0, type: 'easy', share: 0.10, zone: 'easy', title: 'Recovery run' },
    { day: 1, type: 'interval', share: 0.12, zone: 'race', title: 'Race-pace reps', notes: '4 × 2 km at 3:47/km, 2 min jog.' },
    { day: 2, type: 'easy', share: 0.15, zone: 'easy', title: 'Easy run' },
    { day: 3, type: 'easy', share: 0.13, zone: 'easy', title: 'Easy run' },
    { day: 4, type: 'tempo', share: 0.12, zone: 'race', title: 'Race-pace tempo' },
    { day: 5, type: 'easy', share: 0.10, zone: 'easy', title: 'Easy run' },
    { day: 6, type: 'long', share: 0.28, zone: 'long', title: 'Long run w/ race pace', notes: 'Final third at 3:47/km.' },
  ],
  taper: [
    { day: 1, type: 'easy', share: 0.18, zone: 'easy', title: 'Easy run' },
    { day: 2, type: 'tempo', share: 0.15, zone: 'race', title: 'Sharpener', notes: '3 × 1 km at race pace. Quick legs, not tired ones.' },
    { day: 3, type: 'easy', share: 0.18, zone: 'easy', title: 'Easy run' },
    { day: 5, type: 'easy', share: 0.14, zone: 'easy', title: 'Shakeout + strides' },
    { day: 6, type: 'long', share: 0.35, zone: 'long', title: 'Long run', notes: 'Volume is coming down; sharpness is not.' },
  ],
}

const WEEKDAY = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']

export function planWeekRows(now: number): NewPlanWeek[] {
  return Array.from({ length: TOTAL_WEEKS }, (_, week) => ({
    weekIndex: week,
    phase: phaseFor(week),
    focus: phaseOf(week).focus,
    targetVolumeM: weeklyVolumeM(week),
    isDownWeek: isDownWeek(week),
    notes: null,
    updatedAt: now,
  }))
}

export function planSessionRows(now: number): NewPlanSession[] {
  const rows: NewPlanSession[] = []

  for (let week = 0; week < TOTAL_WEEKS; week++) {
    const weekStart = BLOCK_START + week * WEEK_MS
    const isRaceWeek = week === TOTAL_WEEKS - 1
    const template = TEMPLATES[phaseFor(week)]

    // In race week the 21.1 km counts toward the weekly target, so the remaining sessions
    // share what is left rather than being scaled off the full number — otherwise race
    // week lands ~40 km against a 28 km taper target.
    let volumeM = weeklyVolumeM(week)
    if (isRaceWeek) {
      const sundayShare = template.find((slot) => slot.day === 6)?.share ?? 0
      const remaining = Math.max(0, volumeM - HALF_MARATHON_M)
      volumeM = sundayShare < 1 ? remaining / (1 - sundayShare) : remaining
    }

    // dayOrder disambiguates a double day — the run comes before the strength session.
    const orderByDay = new Map<number, number>()

    for (const slot of template) {
      const dayOrder = orderByDay.get(slot.day) ?? 0
      orderByDay.set(slot.day, dayOrder + 1)

      // Race day replaces the final long run.
      const raceDay = isRaceWeek && slot.day === 6
      const band = raceDay ? PACES.race : slot.zone ? PACES[slot.zone] : undefined

      rows.push({
        id: `w${String(week).padStart(2, '0')}-${WEEKDAY[slot.day]}-${dayOrder}`,
        scheduledOn: weekStart + slot.day * DAY_MS,
        dayOrder,
        type: raceDay ? 'race' : slot.type,
        title: raceDay ? 'La Mitja de Granollers' : slot.title,
        notes: raceDay ? 'Race day. Sub-1:20 is 3:47/km.' : (slot.notes ?? null),
        targetDistanceM: raceDay
          ? HALF_MARATHON_M
          : slot.share > 0
            ? Math.round(volumeM * slot.share)
            : null,
        targetDurationS: slot.durationS ?? null,
        targetPaceLoSKm: band?.lo ?? null,
        targetPaceHiSKm: band?.hi ?? null,
        doneAt: null,
        activityId: null,
        updatedAt: now,
      })
    }
  }

  return rows
}

/** Share of a week's volume prescribed at quality intensity, for the guardrail tests. */
export function qualityShare(phase: Phase): number {
  const quality: SessionType[] = ['tempo', 'interval', 'race']
  return TEMPLATES[phase]
    .filter((s) => quality.includes(s.type))
    .reduce((sum, s) => sum + s.share, 0)
}
