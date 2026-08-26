import { describe, expect, it } from 'vitest'
import {
  BLOCK_START,
  DAY_MS,
  RACE_DATE,
  TOTAL_WEEKS,
  WEEK_MS,
  daysToRace,
  startOfWeek,
  weekIndex,
} from '@/lib/block'

/**
 * These used to assert `'2026-08-17T00:00:00.000Z'` outright, which was the right test
 * while the block was compiled in. It comes out of `config.ts` now, so a hardcoded date
 * would be asserting whatever `.env` the machine running the suite happens to have —
 * green on the author's laptop and red on a fork whose only sin is training for another
 * race.
 *
 * What is worth pinning is what has to be true of *any* block: it opens on a Monday, it
 * ends on race day, race day is the last day of the last week, and the countdown counts
 * down. Those are the properties the rest of the app leans on.
 */

describe('block boundaries', () => {
  it('opens on a Monday', () => {
    // Every week in the plan is BLOCK_START + i * WEEK_MS, so a start on any other day
    // would put every week boundary mid-week. `config.ts` refuses one.
    expect(new Date(BLOCK_START).getUTCDay()).toBe(1)
    expect(BLOCK_START).toBe(startOfWeek(BLOCK_START))
  })

  it('ends on race day, in the final week', () => {
    expect(RACE_DATE).toBeGreaterThan(BLOCK_START)
    expect(weekIndex(RACE_DATE)).toBe(TOTAL_WEEKS - 1)
    // Race day falls inside the last week and the block does not run past it.
    expect(RACE_DATE).toBeLessThan(BLOCK_START + TOTAL_WEEKS * WEEK_MS)
    expect(RACE_DATE).toBeGreaterThanOrEqual(BLOCK_START + (TOTAL_WEEKS - 1) * WEEK_MS)
  })

  it('spans a whole number of weeks, rounded up, and never fewer than four', () => {
    expect(TOTAL_WEEKS).toBe(Math.ceil((RACE_DATE - BLOCK_START) / WEEK_MS))
    expect(TOTAL_WEEKS).toBeGreaterThanOrEqual(4)
  })
})

describe('startOfWeek', () => {
  it('snaps back to Monday from any day', () => {
    const monday = BLOCK_START + 4 * WEEK_MS
    for (const offset of [0, 0.25, 3.9, 5.5]) {
      expect(startOfWeek(monday + Math.round(offset * DAY_MS)), `+${offset}d`).toBe(monday)
    }
    // Sunday belongs to the week that began the previous Monday, not the next one.
    expect(startOfWeek(monday + 6 * DAY_MS + DAY_MS - 60_000)).toBe(monday)
    expect(startOfWeek(monday + 7 * DAY_MS)).toBe(monday + WEEK_MS)
  })
})

describe('weekIndex', () => {
  it('is 0 through the first week and counts up from there', () => {
    expect(weekIndex(BLOCK_START)).toBe(0)
    expect(weekIndex(BLOCK_START + 5 * DAY_MS + 9 * 3_600_000)).toBe(0)
    expect(weekIndex(BLOCK_START + 6 * DAY_MS + 23 * 3_600_000)).toBe(0)
    expect(weekIndex(BLOCK_START + WEEK_MS)).toBe(1)
    expect(weekIndex(BLOCK_START + 12 * WEEK_MS)).toBe(12)
  })

  it('is negative before the block starts', () => {
    expect(weekIndex(BLOCK_START - DAY_MS)).toBe(-1)
    expect(weekIndex(BLOCK_START - WEEK_MS)).toBe(-1) // the Monday before
    expect(weekIndex(BLOCK_START - WEEK_MS - DAY_MS)).toBe(-2)
  })
})

describe('daysToRace', () => {
  it('counts whole days and floors at zero', () => {
    expect(daysToRace(BLOCK_START)).toBe((RACE_DATE - BLOCK_START) / DAY_MS)
    expect(daysToRace(RACE_DATE - 30 * DAY_MS)).toBe(30)
    expect(daysToRace(RACE_DATE - DAY_MS + 9 * 3_600_000)).toBe(1)
    expect(daysToRace(RACE_DATE + 7 * 3_600_000)).toBe(0)
    expect(daysToRace(RACE_DATE + 36 * DAY_MS)).toBe(0)
  })

  it('ignores time of day', () => {
    const day = RACE_DATE - 40 * DAY_MS
    expect(daysToRace(day + 60_000)).toBe(daysToRace(day + DAY_MS - 60_000))
  })
})
