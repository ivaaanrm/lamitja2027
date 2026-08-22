import { describe, expect, it } from 'vitest'
import { BLOCK_START, RACE_DATE, TOTAL_WEEKS, daysToRace, startOfWeek, weekIndex } from '@/lib/block'

describe('block boundaries', () => {
  it('starts on Monday 24 Aug 2026 and ends on race day', () => {
    expect(new Date(BLOCK_START).toISOString()).toBe('2026-08-24T00:00:00.000Z')
    expect(new Date(BLOCK_START).getUTCDay()).toBe(1) // Monday
    expect(new Date(RACE_DATE).toISOString()).toBe('2027-01-24T00:00:00.000Z')
  })

  it('spans the 22 weeks the plan is written for', () => {
    expect(TOTAL_WEEKS).toBe(22)
  })
})

describe('startOfWeek', () => {
  it('snaps back to Monday from any day', () => {
    const monday = '2026-08-24T00:00:00.000Z'
    for (const day of ['2026-08-24T06:00:00Z', '2026-08-27T23:30:00Z', '2026-08-30T12:00:00Z']) {
      expect(new Date(startOfWeek(Date.parse(day))).toISOString()).toBe(monday)
    }
    // Sunday belongs to the week that started the previous Monday, not the next one.
    expect(new Date(startOfWeek(Date.parse('2026-08-30T23:59:00Z'))).toISOString()).toBe(monday)
  })
})

describe('weekIndex', () => {
  it('is 0 in the first week and counts up from there', () => {
    expect(weekIndex(Date.parse('2026-08-24T09:00:00Z'))).toBe(0)
    expect(weekIndex(Date.parse('2026-08-30T09:00:00Z'))).toBe(0)
    expect(weekIndex(Date.parse('2026-08-31T09:00:00Z'))).toBe(1)
    expect(weekIndex(RACE_DATE)).toBe(21)
  })

  it('is negative before the block starts', () => {
    expect(weekIndex(Date.parse('2026-08-22T09:00:00Z'))).toBe(-1)
  })
})

describe('daysToRace', () => {
  it('counts whole days and floors at zero', () => {
    expect(daysToRace(Date.parse('2026-08-22T09:00:00Z'))).toBe(155)
    expect(daysToRace(Date.parse('2026-08-24T00:00:00Z'))).toBe(153)
    expect(daysToRace(Date.parse('2027-01-24T07:00:00Z'))).toBe(0)
    expect(daysToRace(Date.parse('2027-03-01T00:00:00Z'))).toBe(0)
  })

  it('ignores time of day', () => {
    expect(daysToRace(Date.parse('2026-08-22T00:01:00Z'))).toBe(
      daysToRace(Date.parse('2026-08-22T23:59:00Z')),
    )
  })
})
