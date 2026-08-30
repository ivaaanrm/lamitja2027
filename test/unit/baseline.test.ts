import { describe, expect, it } from 'vitest'
import {
  BASELINE_KEY,
  BASELINE_RAW,
  PREV_RACE_DATE,
  baselineFor,
  baselineShiftMs,
} from '@/lib/baseline'
import { DAY_MS, HALF_MARATHON_M, WEEK_MS, totalWeeks, weekIndex, type BlockConfig } from '@/lib/block'

/**
 * The baseline is whatever `docs/personal/data/*.csv` holds, which for a fork may be its own export
 * or nothing at all. So the shape is asserted unconditionally and the *values* only when
 * this repository's own rows are present — a fork that deleted them still gets a green
 * suite, which is the point of globbing the directory rather than naming two files.
 *
 * The block is written out here rather than imported from `config.ts`, for the reason
 * `block.test.ts` gives: the real default is whatever `.env` the machine carries.
 */
const OWNER: BlockConfig = {
  startsOn: Date.UTC(2026, 7, 17),
  raceOn: Date.UTC(2027, 0, 24),
  goalTimeS: 4799,
  raceDistanceM: HALF_MARATHON_M,
  raceName: 'La Mitja',
  racePlace: 'Granollers',
}

const hasBaseline = BASELINE_RAW.length > 0

describe('the shift onto a block', () => {
  it('lands last season’s race on this one’s', () => {
    expect(PREV_RACE_DATE + baselineShiftMs(OWNER)).toBe(OWNER.raceOn)
    expect(baselineShiftMs(OWNER)).toBeGreaterThan(0)
  })

  it('is a whole number of weeks, so every row keeps its weekday', () => {
    // 371 days — 53 weeks exactly, for this repository's two editions of the same race.
    // That is what makes "eleven weeks out" comparable *and* Sunday's long run a Sunday.
    expect(baselineShiftMs(OWNER) % WEEK_MS).toBe(0)
  })

  it('follows the block, so moving race day moves the overlay with it', () => {
    // The owner can edit their dates on /ajustes. A shift computed once at module load
    // would leave last season a fortnight out of step and still look plausible.
    const moved = { ...OWNER, raceOn: OWNER.raceOn + 14 * DAY_MS }
    expect(baselineShiftMs(moved) - baselineShiftMs(OWNER)).toBe(14 * DAY_MS)
  })
})

describe('baselineFor', () => {
  it('gives every athlete but the owner nothing', () => {
    // The gate is the whole privacy story here: `docs/personal/data` is one person's Strava export,
    // and handing it to somebody else would draw a stranger's season across their charts
    // and label it "la temporada pasada".
    expect(baselineFor(null, OWNER)).toBeNull()
    expect(baselineFor('someone-else', OWNER)).toBeNull()
    expect(baselineFor('', OWNER)).toBeNull()
  })

  it.skipIf(!hasBaseline)('gives the owner a season laid over their block', () => {
    const baseline = baselineFor(BASELINE_KEY, OWNER)
    expect(baseline).not.toBeNull()
    expect(baseline!.activities.length).toBe(BASELINE_RAW.length)
    expect(baseline!.shiftMs).toBe(baselineShiftMs(OWNER))
  })

  it.skipIf(!hasBaseline)('shifts every row and leaves the raw ones alone', () => {
    const { activities, shiftMs } = baselineFor(BASELINE_KEY, OWNER)!
    activities.forEach((activity, i) => {
      expect(activity.startedOn).toBe(BASELINE_RAW[i]!.startedOn + shiftMs)
    })
  })

  it.skipIf(!hasBaseline)('lands inside the block and reaches race week', () => {
    const { activities, firstWeek } = baselineFor(BASELINE_KEY, OWNER)!
    // Never negative: a previous build longer than this block reaches back past the start,
    // and the first block week it reaches is still week 0.
    expect(firstWeek).toBeGreaterThanOrEqual(0)
    expect(firstWeek).toBeLessThan(totalWeeks(OWNER))
    expect(Math.max(...activities.map((a) => weekIndex(OWNER, a.startedOn)))).toBe(
      totalWeeks(OWNER) - 1,
    )
  })

  it.skipIf(!hasBaseline)('reaches its own race day — the row every comparison is anchored on', () => {
    const race = BASELINE_RAW.find((a) => a.startedOn === PREV_RACE_DATE && a.distanceM > 21_000)
    expect(race).toBeDefined()
    // This repository's own export: La Mitja 2026, 21,1 km in 1:23:57.
    expect(race!.movingS).toBe(5037)
  })

  it.skipIf(!hasBaseline)('keeps the run-in strictly before the block opens', () => {
    const { preBlock } = baselineFor(BASELINE_KEY, OWNER)!
    expect(preBlock.every((a) => a.startedOn < OWNER.startsOn)).toBe(true)
  })

  it.skipIf(!hasBaseline)('reaches far enough back to warm a 42-day average', () => {
    const { preBlock } = baselineFor(BASELINE_KEY, OWNER)!
    const earliest = Math.min(...preBlock.map((a) => a.startedOn))
    expect(OWNER.startsOn - earliest).toBeGreaterThan(42 * DAY_MS)
  })

  it.skipIf(!hasBaseline)('never lets a baseline row collide with a synced one', () => {
    // Negative ids: these rows never touch the database, and a Strava id is positive.
    expect(BASELINE_RAW.every((a) => a.id < 0)).toBe(true)
  })
})
