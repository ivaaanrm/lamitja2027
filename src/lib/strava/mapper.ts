import type { NewActivity, NewLap } from '../db/schema'
import type { StravaActivity, StravaLap } from './types'

/**
 * Strava sends `start_date` as UTC ISO and `start_date_local` as the same instant already
 * shifted into the athlete's local wall clock, but still suffixed `Z`. Parsing both as UTC
 * therefore gives us a UTC instant and a "local clock as if it were UTC" value — which is
 * exactly what we want for "which calendar day was this run", independent of where the
 * device viewing it happens to be.
 */
function toEpochMs(iso: string): number {
  return new Date(iso).getTime()
}

export function mapActivity(activity: StravaActivity, athleteId: number, now: number): NewActivity {
  const [lat, lng] = activity.start_latlng ?? [null, null]

  return {
    id: activity.id,
    athleteId,
    name: activity.name,
    sportType: activity.sport_type ?? activity.type ?? 'Unknown',
    startAt: toEpochMs(activity.start_date),
    startLocalAt: toEpochMs(activity.start_date_local),
    timezone: activity.timezone,
    distanceM: activity.distance,
    movingS: activity.moving_time,
    elapsedS: activity.elapsed_time,
    elevationGainM: activity.total_elevation_gain,
    averageSpeed: activity.average_speed,
    maxSpeed: activity.max_speed,
    averageHeartrate: activity.average_heartrate ?? null,
    maxHeartrate: activity.max_heartrate ?? null,
    averageCadence: activity.average_cadence ?? null,
    averageWatts: activity.average_watts ?? null,
    sufferScore: activity.suffer_score ?? null,
    startLat: lat,
    startLng: lng,
    summaryPolyline: activity.map?.summary_polyline ?? null,
    raw: activity,
    updatedAt: now,
  }
}

export function mapLap(lap: StravaLap, activityId: number, now: number): NewLap {
  return {
    activityId,
    lapIndex: lap.lap_index,
    name: lap.name,
    distanceM: lap.distance,
    movingS: lap.moving_time,
    elapsedS: lap.elapsed_time,
    elevationGainM: lap.total_elevation_gain,
    averageSpeed: lap.average_speed,
    maxSpeed: lap.max_speed,
    averageHeartrate: lap.average_heartrate ?? null,
    maxHeartrate: lap.max_heartrate ?? null,
    averageCadence: lap.average_cadence ?? null,
    paceZone: lap.pace_zone ?? null,
    startAt: lap.start_date ? toEpochMs(lap.start_date) : null,
    updatedAt: now,
  }
}

/** Strava counts cadence in rpm (one leg). Runners think in steps per minute. */
export function cadenceToSpm(averageCadence: number | null): number | null {
  return averageCadence === null ? null : Math.round(averageCadence * 2)
}

/** Sport types that count toward running volume. */
const RUN_TYPES = new Set(['Run', 'TrailRun', 'VirtualRun'])

export function isRun(sportType: string): boolean {
  return RUN_TYPES.has(sportType)
}
