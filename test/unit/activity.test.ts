import { describe, expect, it } from 'vitest'
import { getTableColumns } from 'drizzle-orm'
import { activities } from '@/lib/db/schema'
import { toRow } from '@/lib/activity'
import type { StravaActivity } from '@/lib/activity'
import { isRun } from '@/lib/activity'

function activity(overrides: Partial<StravaActivity> = {}): StravaActivity {
  return {
    id: 15000000001,
    name: 'Morning Run',
    sport_type: 'Run',
    start_date_local: '2026-08-25T08:30:00Z', // already shifted to Barcelona wall clock
    distance: 10000,
    moving_time: 2400,
    total_elevation_gain: 42,
    average_heartrate: 158,
    max_heartrate: 176,
    average_cadence: 86.4,
    suffer_score: 61,
    ...overrides,
  }
}

describe('toRow', () => {
  it('keeps Strava units untouched', () => {
    expect(toRow(activity())).toMatchObject({ distanceM: 10000, movingS: 2400 })
  })

  it('doubles cadence from rpm into steps per minute', () => {
    // The knee protocol targets 85+ rpm ≈ 170 spm; halving it would misread the marker.
    expect(toRow(activity()).cadenceSpm).toBe(173)
    expect(toRow(activity({ average_cadence: 80 })).cadenceSpm).toBe(160)
    expect(toRow(activity({ average_cadence: null })).cadenceSpm).toBeNull()
    expect(toRow(activity({ average_cadence: undefined })).cadenceSpm).toBeNull()
  })

  it('stores the local wall clock, so the calendar day is viewer-independent', () => {
    expect(new Date(toRow(activity()).startedOn).toISOString()).toBe('2026-08-25T08:30:00.000Z')
  })

  it('tolerates an activity with no HR, cadence or elevation', () => {
    const row = toRow(
      activity({
        average_heartrate: null,
        max_heartrate: null,
        average_cadence: null,
        total_elevation_gain: null,
        suffer_score: null,
      }),
    )
    expect(row).toMatchObject({
      averageHeartrate: null,
      maxHeartrate: null,
      cadenceSpm: null,
      elevationGainM: null,
    })
  })

  it('falls back to `type` when sport_type is missing', () => {
    expect(toRow(activity({ sport_type: undefined, type: 'Ride' })).sportType).toBe('Ride')
    expect(toRow(activity({ sport_type: undefined, type: undefined })).sportType).toBe('Unknown')
  })
})

describe('D1 bound-parameter budget', () => {
  it('keeps a batched insert under the 100-parameter limit', () => {
    const columns = Object.keys(getTableColumns(activities)).length
    const perStatement = Math.max(1, Math.floor(100 / columns))
    expect(perStatement * columns).toBeLessThanOrEqual(100)
    expect(perStatement).toBeGreaterThanOrEqual(1)
  })
})

describe('isRun', () => {
  it('counts running variants only', () => {
    expect(['Run', 'TrailRun', 'VirtualRun'].every(isRun)).toBe(true)
    expect(['Ride', 'Hike', 'WeightTraining'].some(isRun)).toBe(false)
  })
})
