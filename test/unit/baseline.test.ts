import { describe, expect, it } from 'vitest'
import { isRun } from '@/lib/activity'
import { BLOCK_START, RACE_DATE, TOTAL_WEEKS, WEEK_MS, weekIndex } from '@/lib/block'
import {
  BASELINE,
  BASELINE_FIRST_WEEK,
  BASELINE_RAW,
  BASELINE_SHIFT_MS,
  PRE_BLOCK,
  PREV_RACE_DATE,
} from '@/lib/baseline'

/**
 * The baseline is now whatever `docs/data/*.csv` holds, which for a fork may be its own
 * export or may be nothing at all. So the assertions split in two: the alignment rules,
 * which hold for any pair of race dates, and the row-level ones, which are skipped
 * cleanly when there are no rows — a fork that deleted the CSVs still has a green suite,
 * and this repository still checks its own data in full.
 */

const hasBaseline = BASELINE_RAW.length > 0
const hasRunIn = PRE_BLOCK.length > 0

describe('the shift onto this block', () => {
  it('lands last season’s race on this season’s race day', () => {
    expect(PREV_RACE_DATE + BASELINE_SHIFT_MS).toBe(RACE_DATE)
    expect(BASELINE_SHIFT_MS).toBeGreaterThan(0)
  })

  it.skipIf(BASELINE_SHIFT_MS % WEEK_MS !== 0)(
    'keeps every weekday when the two races are a whole number of weeks apart',
    () => {
      // The default pair — 18 Jan 2026 and 24 Jan 2027 — is 53 weeks, so last season's
      // Sunday long run stays a Sunday. A fork whose races are not is still aligned on
      // race day, which is the half of it the comparison actually reads.
      expect(new Date(PREV_RACE_DATE).getUTCDay()).toBe(new Date(RACE_DATE).getUTCDay())
    },
  )

  it('moves the rows and nothing else', () => {
    expect(BASELINE).toHaveLength(BASELINE_RAW.length)
    for (const [i, shifted] of BASELINE.entries()) {
      const raw = BASELINE_RAW[i]!
      expect(shifted.startedOn - raw.startedOn).toBe(BASELINE_SHIFT_MS)
      expect(shifted.distanceM).toBe(raw.distanceM)
      expect(shifted.sportType).toBe(raw.sportType)
    }
  })
})

describe('the previous build', () => {
  it.skipIf(!hasBaseline)('parses every row of the export', () => {
    expect(BASELINE_RAW.every((a) => Number.isFinite(a.distanceM) && a.distanceM >= 0)).toBe(true)
    expect(BASELINE_RAW.every((a) => Number.isFinite(a.startedOn))).toBe(true)
    expect(BASELINE_RAW.every((a) => a.name.length > 0)).toBe(true)
  })

  it.skipIf(!hasBaseline)('lands entirely inside this block once shifted', () => {
    for (const activity of BASELINE) {
      expect(activity.startedOn).toBeGreaterThanOrEqual(BLOCK_START)
      expect(activity.startedOn).toBeLessThanOrEqual(RACE_DATE)
    }
  })

  it.skipIf(!hasBaseline)('opens where it opens and runs to race week', () => {
    // This repository's own data opens three weeks in: a 20-week build against a 23-week
    // one, so weeks 1–3 have no counterpart and read as absent rather than as zero.
    expect(BASELINE_FIRST_WEEK).toBe(
      Math.max(0, Math.min(...BASELINE.map((a) => weekIndex(a.startedOn)))),
    )
    // Never negative: a previous build longer than this block reaches back past
    // BLOCK_START, and the first block week it reaches is still week 0.
    expect(BASELINE_FIRST_WEEK).toBeGreaterThanOrEqual(0)
    expect(BASELINE_FIRST_WEEK).toBeLessThan(TOTAL_WEEKS)
    expect(Math.max(...BASELINE.map((a) => weekIndex(a.startedOn)))).toBe(TOTAL_WEEKS - 1)
  })

  it.skipIf(hasBaseline)('reads as a season the block never reaches when there are no CSVs', () => {
    // `Math.min()` of nothing is Infinity, which orders correctly and then renders itself
    // into the sentence on /progreso as the word "Infinity".
    expect(BASELINE_FIRST_WEEK).toBe(TOTAL_WEEKS)
    expect(Number.isFinite(BASELINE_FIRST_WEEK)).toBe(true)
  })

  it.skipIf(!hasBaseline)('carries the sports the comparison depends on telling apart', () => {
    const sports = new Set(BASELINE_RAW.map((a) => a.sportType))
    expect([...sports].every((sport) => sport.length > 0)).toBe(true)
    expect([...sports].some((sport) => isRun(sport))).toBe(true)
    // Everything that is not a `Run` is deliberately not counted as one — the default
    // export carries hikes, and a hike is not a training kilometre.
    expect([...sports].filter((sport) => isRun(sport))).toEqual(['Run'])
  })

  it('keeps ids negative and unique, so they can never be mistaken for Strava rows', () => {
    const ids = [...BASELINE_RAW, ...PRE_BLOCK].map((a) => a.id)
    expect(ids.every((id) => id < 0)).toBe(true)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it.skipIf(!hasBaseline)('reaches its own race day — the row every comparison is anchored on', () => {
    const raceDay = BASELINE_RAW.filter((a) => a.startedOn === PREV_RACE_DATE)
    expect(raceDay.length).toBeGreaterThan(0)
    // This repository's own export: La Mitja 2026, 21,1 km in 1:23:57.
    const race = raceDay.find((a) => a.distanceM > 21_000)
    if (race) expect(race.movingS).toBe(5037)
  })
})

describe('the pre-block ramp', () => {
  it('is only what happened before the block opened', () => {
    expect(PRE_BLOCK.every((a) => a.startedOn < BLOCK_START)).toBe(true)
  })

  it.skipIf(!hasRunIn)('reaches back far enough to run in a 42-day average', () => {
    // The whole reason it exists: a 42-day average that opens at zero reads as six weeks
    // of gains that were really the average catching up with reality.
    const earliest = Math.min(...PRE_BLOCK.map((a) => a.startedOn))
    expect(BLOCK_START - earliest).toBeGreaterThan(42 * 86_400_000)
  })
})
