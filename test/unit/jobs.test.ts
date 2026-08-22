import { describe, expect, it } from 'vitest'
import { backoffMs, MAX_ATTEMPTS } from '@/lib/sync/jobs'

describe('backoffMs', () => {
  it('grows exponentially from the first retry', () => {
    expect(backoffMs(1)).toBe(60_000)
    expect(backoffMs(2)).toBe(120_000)
    expect(backoffMs(3)).toBe(240_000)
  })

  it('stays under half an hour within the attempt budget', () => {
    // The hour cap is defensive: at MAX_ATTEMPTS the curve only reaches 32 minutes, so a
    // job is parked as failed long before the ceiling ever binds.
    expect(backoffMs(MAX_ATTEMPTS)).toBe(32 * 60 * 1000)
    expect(backoffMs(MAX_ATTEMPTS)).toBeLessThan(60 * 60 * 1000)
  })

  it('caps at an hour for any attempt count beyond the budget', () => {
    expect(backoffMs(20)).toBe(60 * 60 * 1000)
    expect(backoffMs(100)).toBe(60 * 60 * 1000)
  })

  it('spans a useful window before giving up', () => {
    const total = Array.from({ length: MAX_ATTEMPTS }, (_, i) => backoffMs(i + 1)).reduce(
      (a, b) => a + b,
      0,
    )
    // Just over an hour of retries in total before a job is parked as failed — long
    // enough to ride out a Strava outage, short enough to notice.
    expect(total).toBe(63 * 60 * 1000)
  })
})
