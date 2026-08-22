import { describe, expect, it } from 'vitest'
import { BLOCK_START, RACE_DATE, TOTAL_WEEKS, daysToRace, startOfWeek, weekIndex } from '@/lib/block'

describe('block boundaries', () => {
  it('starts on Monday 17 Aug 2026 and ends on race day', () => {
    expect(new Date(BLOCK_START).toISOString()).toBe('2026-08-17T00:00:00.000Z')
    expect(new Date(BLOCK_START).getUTCDay()).toBe(1) // Monday
    expect(new Date(RACE_DATE).toISOString()).toBe('2027-01-24T00:00:00.000Z')
    expect(new Date(RACE_DATE).getUTCDay()).toBe(0) // Sunday
  })

  it('spans 23 weeks', () => {
    // 160 days is 22 weeks and 6 days: race day is the Sunday of the 23rd week, so the
    // count rounds up. docs/03 says 22 because it was written for a 24 Aug start.
    expect(TOTAL_WEEKS).toBe(23)
    expect(BLOCK_START + (TOTAL_WEEKS - 1) * 7 * 86_400_000 + 6 * 86_400_000).toBe(RACE_DATE)
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
    expect(weekIndex(Date.parse('2026-08-17T09:00:00Z'))).toBe(0)
    expect(weekIndex(Date.parse('2026-08-22T09:00:00Z'))).toBe(0)
    expect(weekIndex(Date.parse('2026-08-23T23:00:00Z'))).toBe(0)
    expect(weekIndex(Date.parse('2026-08-24T09:00:00Z'))).toBe(1)
  })

  it('puts race day in the final week', () => {
    expect(weekIndex(RACE_DATE)).toBe(TOTAL_WEEKS - 1)
  })

  it('is negative before the block starts', () => {
    expect(weekIndex(Date.parse('2026-08-16T09:00:00Z'))).toBe(-1)
    expect(weekIndex(Date.parse('2026-08-10T09:00:00Z'))).toBe(-1) // the Monday before
    expect(weekIndex(Date.parse('2026-08-03T09:00:00Z'))).toBe(-2)
  })
})

describe('daysToRace', () => {
  it('counts whole days and floors at zero', () => {
    expect(daysToRace(Date.parse('2026-08-22T09:00:00Z'))).toBe(155)
    expect(daysToRace(Date.parse('2027-01-23T09:00:00Z'))).toBe(1)
    expect(daysToRace(Date.parse('2027-01-24T07:00:00Z'))).toBe(0)
    expect(daysToRace(Date.parse('2027-03-01T00:00:00Z'))).toBe(0)
  })

  it('ignores time of day', () => {
    expect(daysToRace(Date.parse('2026-08-22T00:01:00Z'))).toBe(
      daysToRace(Date.parse('2026-08-22T23:59:00Z')),
    )
  })
})
