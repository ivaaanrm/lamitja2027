import { describe, expect, it } from 'vitest'
import {
  type BlockConfig,
  DAY_MS,
  DEFAULT_BLOCK,
  HALF_MARATHON_M,
  MIN_BLOCK_WEEKS,
  WEEK_MS,
  daysToRace,
  goalPaceSKm,
  startOfWeek,
  totalWeeks,
  weekDays,
  weekIndex,
  weekStart,
} from '@/lib/block'

/**
 * Two blocks, both written out here rather than imported.
 *
 * `OWNER` is `DEFAULT_BLOCK`'s own numbers as a *literal*, on purpose: the real one is
 * whatever `PUBLIC_*` the machine running this suite happens to carry, so asserting
 * `'2026-08-17T00:00:00.000Z'` against it would be green on the author's laptop and red on
 * a fork whose only sin is training for another race. What must hold of the *actual*
 * default block is asserted separately at the foot of this file, as invariants.
 *
 * `OTHER` is a second athlete — 10 weeks to a 10K — and it is what most of these tests are
 * really for: every function here takes its block as the first argument, and the way that
 * goes wrong is silently reading somebody else's.
 */
const OWNER: BlockConfig = {
  startsOn: Date.UTC(2026, 7, 17), // Monday 17 Aug 2026
  raceOn: Date.UTC(2027, 0, 24), // Sunday 24 Jan 2027
  goalTimeS: 4799,
  raceDistanceM: HALF_MARATHON_M,
  raceName: 'La Mitja',
  racePlace: 'Granollers',
}


const OTHER: BlockConfig = {
  startsOn: Date.UTC(2026, 8, 7), // Monday 7 Sep 2026
  raceOn: Date.UTC(2026, 10, 15), // Sunday 15 Nov 2026
  goalTimeS: 2400,
  raceDistanceM: 10_000,
  raceName: 'Cursa dels Nassos',
  racePlace: null,
}

describe('block boundaries', () => {
  it('starts on Monday 17 Aug 2026 and ends on race day', () => {
    expect(new Date(OWNER.startsOn).toISOString()).toBe('2026-08-17T00:00:00.000Z')
    expect(new Date(OWNER.startsOn).getUTCDay()).toBe(1) // Monday
    expect(new Date(OWNER.raceOn).toISOString()).toBe('2027-01-24T00:00:00.000Z')
    expect(new Date(OWNER.raceOn).getUTCDay()).toBe(0) // Sunday
    expect(OWNER.raceDistanceM).toBe(HALF_MARATHON_M)
  })

  it('spans 23 weeks', () => {
    // 160 days is 22 weeks and 6 days: race day is the Sunday of the 23rd week, so the
    // count rounds up. docs/03 says 22 because it was written for a 24 Aug start.
    expect(totalWeeks(OWNER)).toBe(23)
    expect(
      OWNER.startsOn + (totalWeeks(OWNER) - 1) * WEEK_MS + 6 * DAY_MS,
    ).toBe(OWNER.raceOn)
  })

  it('counts another athlete’s weeks off their own dates', () => {
    expect(totalWeeks(OTHER)).toBe(10)
  })
})

describe('startOfWeek', () => {
  it('snaps back to Monday from any day', () => {
    const monday = '2026-08-17T00:00:00.000Z'
    for (const day of ['2026-08-17T06:00:00Z', '2026-08-20T23:30:00Z', '2026-08-22T12:00:00Z']) {
      expect(new Date(startOfWeek(Date.parse(day))).toISOString()).toBe(monday)
    }
    // Sunday belongs to the week that began the previous Monday, not the next one.
    expect(new Date(startOfWeek(Date.parse('2026-08-23T23:59:00Z'))).toISOString()).toBe(monday)
  })
})

describe('weekIndex', () => {
  it('is 0 through the first week and counts up from there', () => {
    expect(weekIndex(OWNER, Date.parse('2026-08-17T09:00:00Z'))).toBe(0)
    expect(weekIndex(OWNER, Date.parse('2026-08-22T09:00:00Z'))).toBe(0)
    expect(weekIndex(OWNER, Date.parse('2026-08-23T23:00:00Z'))).toBe(0)
    expect(weekIndex(OWNER, Date.parse('2026-08-24T09:00:00Z'))).toBe(1)
  })

  it('puts race day in the final week', () => {
    expect(weekIndex(OWNER, OWNER.raceOn)).toBe(totalWeeks(OWNER) - 1)
    expect(weekIndex(OTHER, OTHER.raceOn)).toBe(totalWeeks(OTHER) - 1)
  })

  it('is negative before the block starts', () => {
    expect(weekIndex(OWNER, Date.parse('2026-08-16T09:00:00Z'))).toBe(-1)
    expect(weekIndex(OWNER, Date.parse('2026-08-10T09:00:00Z'))).toBe(-1) // the Monday before
    expect(weekIndex(OWNER, Date.parse('2026-08-03T09:00:00Z'))).toBe(-2)
  })

  it('counts from the block it is handed, not from a compiled-in one', () => {
    // The same instant is week 3 of the owner's block and week 0 of the other athlete's.
    const at = Date.parse('2026-09-09T09:00:00Z')
    expect(weekIndex(OWNER, at)).toBe(3)
    expect(weekIndex(OTHER, at)).toBe(0)
  })
})

describe('weekStart and weekDays', () => {
  it('round-trips with weekIndex', () => {
    for (let i = 0; i < totalWeeks(OWNER); i++) {
      expect(weekIndex(OWNER, weekStart(OWNER, i))).toBe(i)
      expect(new Date(weekStart(OWNER, i)).getUTCDay()).toBe(1) // always a Monday
    }
  })

  it('lays out seven consecutive days, Monday first', () => {
    const days = weekDays(OWNER, 0)
    expect(days).toHaveLength(7)
    expect(days[0]).toBe(OWNER.startsOn)
    expect(days.every((day, i) => day === OWNER.startsOn + i * DAY_MS)).toBe(true)
    expect(new Date(days[6]!).getUTCDay()).toBe(0) // Sunday closes the week
  })
})

describe('daysToRace', () => {
  it('counts whole days and floors at zero', () => {
    expect(daysToRace(OWNER, Date.parse('2026-08-22T09:00:00Z'))).toBe(155)
    expect(daysToRace(OWNER, Date.parse('2027-01-23T09:00:00Z'))).toBe(1)
    expect(daysToRace(OWNER, Date.parse('2027-01-24T07:00:00Z'))).toBe(0)
    expect(daysToRace(OWNER, Date.parse('2027-03-01T00:00:00Z'))).toBe(0)
  })

  it('ignores time of day', () => {
    expect(daysToRace(OWNER, Date.parse('2026-08-22T00:01:00Z'))).toBe(
      daysToRace(OWNER, Date.parse('2026-08-22T23:59:00Z')),
    )
  })
})

describe('goalPaceSKm', () => {
  it('is 3:47/km for a sub-1:20 half', () => {
    expect(goalPaceSKm(OWNER)).toBeCloseTo(227.47, 2)
    expect(Math.round(goalPaceSKm(OWNER))).toBe(227) // 3:47
  })

  it('reads a shorter race off its own distance', () => {
    expect(goalPaceSKm(OTHER)).toBe(240) // 40:00 for 10 km is 4:00/km
  })
})

/**
 * The block this deployment is actually configured for — whatever `.env` says.
 *
 * Only the properties every block has to satisfy, never its values: the ones above already
 * pin the numbers, and these are what the rest of the app leans on being true of *any*
 * block, including a fork's.
 */
describe('the configured default block', () => {
  it('opens on a Monday', () => {
    // Every week in a plan is `startsOn + i * WEEK_MS`, so any other day would put every
    // week boundary mid-week. `config.ts` refuses one at build time.
    expect(new Date(DEFAULT_BLOCK.startsOn).getUTCDay()).toBe(1)
    expect(DEFAULT_BLOCK.startsOn).toBe(startOfWeek(DEFAULT_BLOCK.startsOn))
  })

  it('ends on race day, inside the final week, and is long enough to ramp', () => {
    const weeks = totalWeeks(DEFAULT_BLOCK)
    expect(DEFAULT_BLOCK.raceOn).toBeGreaterThan(DEFAULT_BLOCK.startsOn)
    expect(weekIndex(DEFAULT_BLOCK, DEFAULT_BLOCK.raceOn)).toBe(weeks - 1)
    expect(DEFAULT_BLOCK.raceOn).toBeLessThan(DEFAULT_BLOCK.startsOn + weeks * WEEK_MS)
    expect(weeks).toBeGreaterThanOrEqual(MIN_BLOCK_WEEKS)
  })

  it('has a positive goal and distance, so goal pace is a real number', () => {
    expect(DEFAULT_BLOCK.goalTimeS).toBeGreaterThan(0)
    expect(DEFAULT_BLOCK.raceDistanceM).toBeGreaterThan(0)
    expect(goalPaceSKm(DEFAULT_BLOCK)).toBeGreaterThan(0)
    expect(DEFAULT_BLOCK.raceName.length).toBeGreaterThan(0)
  })
})
