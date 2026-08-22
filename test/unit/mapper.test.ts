import { describe, expect, it } from 'vitest'
import { cadenceToSpm, isRun, mapActivity, mapLap } from '@/lib/strava/mapper'
import type { StravaActivity, StravaLap } from '@/lib/strava/types'

const NOW = Date.UTC(2026, 7, 22, 12, 0, 0)
const ATHLETE = 56881786

/** Shaped like a real Strava payload for a morning run in Barcelona (UTC+2). */
function activity(overrides: Partial<StravaActivity> = {}): StravaActivity {
  return {
    id: 15000000001,
    athlete: { id: ATHLETE },
    name: 'Morning Run',
    sport_type: 'Run',
    start_date: '2026-08-22T06:30:00Z',
    start_date_local: '2026-08-22T08:30:00Z',
    timezone: '(GMT+01:00) Europe/Madrid',
    distance: 10000,
    moving_time: 2400,
    elapsed_time: 2450,
    total_elevation_gain: 42,
    average_speed: 4.1666,
    max_speed: 5.2,
    average_heartrate: 158,
    max_heartrate: 176,
    average_cadence: 86.5,
    start_latlng: [41.6, 2.28],
    map: { summary_polyline: 'abc123' },
    ...overrides,
  }
}

describe('mapActivity', () => {
  it('keeps Strava units untouched', () => {
    const row = mapActivity(activity(), ATHLETE, NOW)
    // Metres and seconds, exactly as Strava sent them — no conversion at the boundary.
    expect(row).toMatchObject({ distanceM: 10000, movingS: 2400, elapsedS: 2450, averageSpeed: 4.1666 })
  })

  it('separates the UTC instant from the local wall clock', () => {
    const row = mapActivity(activity(), ATHLETE, NOW)
    expect(new Date(row.startAt).toISOString()).toBe('2026-08-22T06:30:00.000Z')
    // start_date_local is already shifted by Strava; parsing it as UTC is what makes
    // "which calendar day was this run" stable regardless of the viewing device.
    expect(new Date(row.startLocalAt).toISOString()).toBe('2026-08-22T08:30:00.000Z')
    expect(row.startLocalAt - row.startAt).toBe(2 * 60 * 60 * 1000)
  })

  it('flattens start_latlng and the polyline', () => {
    const row = mapActivity(activity(), ATHLETE, NOW)
    expect(row).toMatchObject({ startLat: 41.6, startLng: 2.28, summaryPolyline: 'abc123' })
  })

  it('tolerates a activity with no GPS, HR or cadence', () => {
    const row = mapActivity(
      activity({ start_latlng: null, map: null, average_heartrate: null, average_cadence: undefined }),
      ATHLETE,
      NOW,
    )
    expect(row).toMatchObject({
      startLat: null,
      startLng: null,
      summaryPolyline: null,
      averageHeartrate: null,
      averageCadence: null,
    })
  })

  it('falls back to `type` when sport_type is absent on older activities', () => {
    const legacy = activity()
    delete (legacy as Partial<StravaActivity>).sport_type
    legacy.type = 'Ride'
    expect(mapActivity(legacy as StravaActivity, ATHLETE, NOW).sportType).toBe('Ride')
  })

  it('keeps the raw payload so reprocessing never costs another API call', () => {
    expect(mapActivity(activity(), ATHLETE, NOW).raw).toMatchObject({ id: 15000000001 })
  })
})

describe('mapLap', () => {
  it('maps a lap and preserves its index', () => {
    const lap: StravaLap = {
      id: 1,
      lap_index: 3,
      name: 'Lap 3',
      distance: 1000,
      moving_time: 227,
      elapsed_time: 227,
      total_elevation_gain: 2,
      average_speed: 4.405,
      max_speed: 4.9,
      average_heartrate: 172,
      pace_zone: 4,
      start_date: '2026-08-22T06:40:00Z',
    }
    expect(mapLap(lap, 15000000001, NOW)).toMatchObject({
      activityId: 15000000001,
      lapIndex: 3,
      distanceM: 1000,
      movingS: 227,
      paceZone: 4,
    })
  })
})

describe('cadenceToSpm', () => {
  it('doubles rpm into steps per minute', () => {
    // The knee protocol targets 85+ rpm (≈170 spm); getting this wrong halves the marker.
    expect(cadenceToSpm(86.4)).toBe(173)
    expect(cadenceToSpm(80)).toBe(160)
    expect(cadenceToSpm(null)).toBeNull()
  })
})

describe('isRun', () => {
  it('counts every running variant toward volume, and nothing else', () => {
    expect(['Run', 'TrailRun', 'VirtualRun'].every(isRun)).toBe(true)
    expect(['Ride', 'Walk', 'Hike', 'WeightTraining', 'Swim'].some(isRun)).toBe(false)
  })
})
