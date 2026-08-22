/**
 * Training paces, seconds per kilometre, from docs/03-training-plan-2027.md §4.
 *
 * Goal-derived rather than VDOT-derived: the target is the input, and the January
 * checkpoint is what tests whether it was ever realistic.
 */
interface PaceBand {
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
