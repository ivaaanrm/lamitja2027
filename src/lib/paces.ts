import { GOAL_TIME_S, HR_MAX, RACE_DISTANCE_M } from './config'

/**
 * Training paces, seconds per kilometre, from docs/03-training-plan-2027.md §4.
 *
 * Goal-derived rather than VDOT-derived, and now that literally: the six bands are
 * *ratios of goal pace*, so the target really is the input. The January checkpoint is
 * what tests whether it was ever realistic.
 *
 * A ratio rather than an offset because ability scales and offsets do not. Goal pace
 * plus 73 s/km is a sane easy run for the 3:47/km runner these bands were written for
 * and nonsense for a 5:30/km one, who would be asked to jog at 6:43 — while +18% of
 * goal pace is the same *effort* at either ability. The calibration point is docs/03 §4:
 * at the default goal of 1:19:59 over 21 097,5 m — 227,467 s/km — every ratio below
 * rounds back to exactly the second it was derived from, which is what
 * `test/unit/paces.test.ts` pins.
 *
 * What a ratio cannot know is that the *shape* of the table is a claim about a
 * well-trained runner racing a half: six bands over five zones, with goal pace sitting
 * at the top of Z4. That claim travels with the goal reasonably well and not infinitely
 * — a 2:30 half is not raced at threshold — so a fork moving a long way from this goal
 * should read §4 again rather than trust the arithmetic.
 */
export interface PaceBand {
  /** Faster bound, s/km. */
  lo: number
  /** Slower bound, s/km. */
  hi: number
}

/** Goal race pace, s/km. `metrics.ts` derives the same number for the projection card. */
const GOAL_PACE_S_KM = GOAL_TIME_S / (RACE_DISTANCE_M / 1000)

/**
 * Each band as a share of goal pace. The trailing comment on every line is the pace it
 * was derived from — docs/03 §4, at a 1:19:59 goal — and six decimal places is what
 * keeps `Math.round(ratio * 227.467)` landing back on exactly those seconds.
 */
const BAND_RATIOS = {
  easy: { lo: 1.318869, hi: 1.450755 }, // 5:00–5:30/km
  long: { lo: 1.252925, hi: 1.362831 }, // 4:45–5:10/km
  steady: { lo: 1.143019, hi: 1.208963 }, // 4:20–4:35/km
  threshold: { lo: 1.011133, hi: 1.046302 }, // 3:50–3:58/km
  /** Goal race pace itself: the band opens two seconds under it and closes on it. */
  race: { lo: 0.989151, hi: 0.997944 }, // 3:45–3:47/km
  vo2: { lo: 0.923208, hi: 0.967170 }, // 3:30–3:40/km
} as const satisfies Record<string, PaceBand>

export type PaceZone = keyof typeof BAND_RATIOS

/**
 * The table at a given goal pace. Exported so the derivation can be tested at goals
 * nobody in this repository is training for — the whole point of expressing the bands as
 * ratios is that they hold for a runner who is not this one.
 *
 * Whole seconds, because a pace band is read off a watch: a bound of 300,4 s/km is a
 * false precision that no session is run to.
 */
export function bandsForGoalPace(goalPaceSKm: number): Record<PaceZone, PaceBand> {
  const band = (ratios: PaceBand): PaceBand => ({
    lo: Math.round(ratios.lo * goalPaceSKm),
    hi: Math.round(ratios.hi * goalPaceSKm),
  })
  return {
    easy: band(BAND_RATIOS.easy),
    long: band(BAND_RATIOS.long),
    steady: band(BAND_RATIOS.steady),
    threshold: band(BAND_RATIOS.threshold),
    race: band(BAND_RATIOS.race),
    vo2: band(BAND_RATIOS.vo2),
  }
}

export const PACES: Record<PaceZone, PaceBand> = bandsForGoalPace(GOAL_PACE_S_KM)

/** Runtime list of the zones — the validator needs one, `keyof` is types only. */
export const PACE_ZONES = Object.keys(PACES) as [PaceZone, ...PaceZone[]]

// ---------------------------------------------------------------------------
// The five-zone model
//
// Intensity is said as Z1–Z5 everywhere it is said at all: it is the vocabulary the
// athlete already trains in, it survives a bad HR strap, and it means the same thing on
// a climb as on the flat — which an exact heart rate does not.
// ---------------------------------------------------------------------------

export type Zone = 1 | 2 | 3 | 4 | 5

/** How a zone reads on its own — the chip, the legend, the card. */
export const ZONE_NAME: Record<Zone, string> = {
  1: 'Z1 · Recuperación',
  2: 'Z2 · Suave',
  3: 'Z3 · Medio',
  4: 'Z4 · Umbral',
  5: 'Z5 · VO₂máx',
}

/** Just the tag — `Z4` — for the places a line has no room for the word. */
export const zoneTag = (zone: Zone) => `Z${zone}`

/**
 * Which of the five a pace band belongs to. Six bands over five zones: the long-run band
 * and the easy band are both Z2, and race pace sits at the top of Z4 rather than in a
 * zone of its own — for a half raced near threshold, which is what a sub-1:20 is, goal
 * pace *is* threshold. The mapping is on the band, not on the pace, so it survives the
 * goal changing: the bands move together and their order does not change.
 */
export const PACE_ZONE_NUMBER: Record<PaceZone, Zone> = {
  easy: 2,
  long: 2,
  steady: 3,
  threshold: 4,
  race: 4,
  vo2: 5,
}

/** How the pace band reads on a session card — its zone, then what the session calls it. */
export const ZONE_LABEL: Record<PaceZone, string> = {
  easy: 'Z2 · Suave',
  long: 'Z2 · Rodaje largo',
  steady: 'Z3 · Medio',
  threshold: 'Z4 · Umbral',
  race: 'Z4 · Ritmo de carrera',
  vo2: 'Z5 · VO₂máx',
}

/**
 * Maximum heart rate. It comes from `config.ts` now — it is a fact about an athlete, not
 * about the app — and is re-exported here so this file stays the one place the zone model
 * lives: a caller that wants zones should never have to know where the number behind them
 * was read.
 *
 * The default, from docs/01 §: 191 seen in the El Tast 10K and 185 in the half, against
 * an estimated 192–195. The lower end of the estimate is used — an inflated maximum
 * quietly pushes every run down a zone.
 */
export { HR_MAX }

/**
 * Where each zone opens, as a share of `HR_MAX` — shares rather than bpm for the same
 * reason the pace bands are ratios: they are the model, and the athlete's maximum is the
 * input. Calibrated against the two races the app has real data for rather than a
 * textbook: the half was run at 172 avg (top of Z4) and the 10K at 176 (Z4 into Z5),
 * which is exactly where a half and a 10K should land.
 */
const ZONE_FLOOR: Record<Exclude<Zone, 1>, number> = {
  2: 0.72,
  3: 0.82,
  4: 0.87,
  5: 0.92,
}

/**
 * The zone an average heart rate falls in.
 *
 * This is the only thing the app ever does with a heart rate: a run reports "Z3", never
 * "151 ppm". The exact number is noise — it drifts with heat, sleep and the strap — and
 * it is not what any decision in the plan is made on.
 */
export function hrZone(bpm: number): Zone {
  const share = bpm / HR_MAX
  if (share >= ZONE_FLOOR[5]) return 5
  if (share >= ZONE_FLOOR[4]) return 4
  if (share >= ZONE_FLOOR[3]) return 3
  if (share >= ZONE_FLOOR[2]) return 2
  return 1
}

/** Where each zone opens, in bpm — the reference lines on a heart-rate trace. */
export const ZONE_FLOOR_BPM: Record<Exclude<Zone, 1>, number> = {
  2: Math.round(ZONE_FLOOR[2] * HR_MAX),
  3: Math.round(ZONE_FLOOR[3] * HR_MAX),
  4: Math.round(ZONE_FLOOR[4] * HR_MAX),
  5: Math.round(ZONE_FLOOR[5] * HR_MAX),
}

/** Mid-band pace, s/km — what a prescribed distance is costed at when estimating time. */
export const midOf = (band: PaceBand) => (band.lo + band.hi) / 2

export const midPaceSKm = (zone: PaceZone) => midOf(PACES[zone])
