import { describe, expect, it } from 'vitest'
import { RACE_DATE, raceCountdown } from '@/lib/training/countdown'

describe('raceCountdown', () => {
  it('counts whole days to race day', () => {
    // 22 Aug 2026 → 24 Jan 2027.
    expect(raceCountdown(new Date('2026-08-22T09:00:00Z'))).toEqual({ daysToGo: 155, weeksToGo: 22 })
  })

  it('ignores the time of day', () => {
    const early = raceCountdown(new Date('2026-08-22T00:01:00Z'))
    const late = raceCountdown(new Date('2026-08-22T23:59:00Z'))
    expect(early).toEqual(late)
  })

  it('reaches zero on race day and stays there afterwards', () => {
    expect(raceCountdown(new Date('2027-01-24T07:00:00Z')).daysToGo).toBe(0)
    expect(raceCountdown(new Date('2027-02-01T00:00:00Z')).daysToGo).toBe(0)
  })

  it('targets the documented race date', () => {
    expect(RACE_DATE.toISOString()).toBe('2027-01-24T00:00:00.000Z')
  })
})
