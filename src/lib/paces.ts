/**
 * Training paces, seconds per kilometre, from docs/03-training-plan-2027.md §4.
 *
 * Goal-derived rather than VDOT-derived: the target is the input, and the January
 * checkpoint is what tests whether it was ever realistic.
 */
export interface PaceBand {
  /** Faster bound, s/km. */
  lo: number
  /** Slower bound, s/km. */
  hi: number
}

const mmss = (minutes: number, seconds: number) => minutes * 60 + seconds

export const PACES = {
  easy: { lo: mmss(5, 0), hi: mmss(5, 30) },
  long: { lo: mmss(4, 45), hi: mmss(5, 10) },
  steady: { lo: mmss(4, 20), hi: mmss(4, 35) },
  threshold: { lo: mmss(3, 50), hi: mmss(3, 58) },
  /** Goal race pace — sub-1:20 is 3:47/km. */
  race: { lo: mmss(3, 45), hi: mmss(3, 47) },
  vo2: { lo: mmss(3, 30), hi: mmss(3, 40) },
} as const satisfies Record<string, PaceBand>

export type PaceZone = keyof typeof PACES

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
 * zone of its own — for a sub-1:20 half, goal pace *is* threshold.
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
 * Maximum heart rate, from docs/01 §: 191 seen in the El Tast 10K and 185 in the half,
 * against an estimated 192–195. The lower end of the estimate is used — an inflated
 * maximum quietly pushes every run down a zone.
 */
export const HR_MAX = 192

/**
 * Where each zone opens, as a share of `HR_MAX`. Calibrated against the two races the
 * app has real data for rather than a textbook: the half was run at 172 avg (top of Z4)
 * and the 10K at 176 (Z4 into Z5), which is exactly where a half and a 10K should land.
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
