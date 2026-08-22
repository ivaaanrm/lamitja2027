import { decimal } from './format'
import type { NewActivity } from './db/schema'

/**
 * Pure activity logic — no bindings, no fetch, no `cloudflare:workers`. Everything here
 * is unit-testable in plain Node, which is why the mapping lives apart from the sync that
 * calls it.
 */

/** The shape of a Strava summary activity, narrowed to what the app stores. */
export interface StravaActivity {
  id: number
  name: string
  sport_type?: string
  type?: string
  start_date_local: string
  distance: number
  moving_time: number
  total_elevation_gain: number | null
  average_heartrate?: number | null
  max_heartrate?: number | null
  average_cadence?: number | null
  suffer_score?: number | null
}

/**
 * Strava reports cadence in rpm (one leg). Runners think in steps per minute, and the
 * knee protocol's target is 85+ rpm ≈ 170 spm — halving it would misread the marker.
 */
function toSpm(rpm: number | null | undefined): number | null {
  return rpm == null ? null : Math.round(rpm * 2)
}

export function toRow(activity: StravaActivity): NewActivity {
  return {
    id: activity.id,
    name: activity.name,
    sportType: activity.sport_type ?? activity.type ?? 'Unknown',
    // `start_date_local` is the instant already shifted to the athlete's wall clock but
    // still suffixed Z, so parsing it as UTC gives a stable "which day was this run".
    startedOn: new Date(activity.start_date_local).getTime(),
    distanceM: activity.distance,
    movingS: activity.moving_time,
    elevationGainM: activity.total_elevation_gain,
    averageHeartrate: activity.average_heartrate ?? null,
    maxHeartrate: activity.max_heartrate ?? null,
    cadenceSpm: toSpm(activity.average_cadence),
    sufferScore: activity.suffer_score ?? null,
    updatedAt: Date.now(),
  }
}

/** Sport types that count toward running volume. */
export const isRun = (sportType: string) =>
  sportType === 'Run' || sportType === 'TrailRun' || sportType === 'VirtualRun'

/** Seconds per kilometre. */
export const paceSKm = (distanceM: number, movingS: number) =>
  distanceM > 0 ? movingS / (distanceM / 1000) : 0

/** `4:32` from 272 s/km. */
export function formatPace(secondsPerKm: number): string {
  const total = Math.round(secondsPerKm)
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}

/** `12,4` km from metres — one decimal, which is the precision a GPS watch actually has. */
export const formatKm = (metres: number) => decimal(metres / 1000)

/** `1h 12m` / `48m` — durations here are training sessions, so seconds are noise. */
export function formatDuration(seconds: number): string {
  const total = Math.round(seconds / 60)
  const hours = Math.floor(total / 60)
  return hours > 0 ? `${hours}h ${String(total % 60).padStart(2, '0')}m` : `${total}m`
}

/** `1:19:59` — a race time, where every second is the point and `1h 20m` is not. */
export function formatClock(seconds: number): string {
  const total = Math.round(seconds)
  const mm = String(Math.floor(total / 60) % 60).padStart(2, '0')
  const ss = String(total % 60).padStart(2, '0')
  const hours = Math.floor(total / 3600)
  return hours > 0 ? `${hours}:${mm}:${ss}` : `${Number(mm)}:${ss}`
}

/** `3:47–4:05` from a pace band, or a single pace when only one bound is set. */
export function formatPaceRange(lo: number | null, hi: number | null): string | null {
  if (lo == null && hi == null) return null
  if (lo == null || hi == null) return `${formatPace((lo ?? hi) as number)}/km`
  return lo === hi ? `${formatPace(lo)}/km` : `${formatPace(lo)}–${formatPace(hi)}/km`
}

/** `3:47` → 227 s/km. `null` for anything that is not `m:ss`, so a typo never saves as 0. */
export function parsePace(value: string): number | null {
  const match = value.trim().match(/^(\d{1,3}):([0-5]\d)$/)
  return match ? Number(match[1]) * 60 + Number(match[2]) : null
}
