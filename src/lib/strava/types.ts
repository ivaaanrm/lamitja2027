/** Subset of the Strava API surface this app consumes. */

export interface StravaTokenResponse {
  token_type: 'Bearer'
  /** Epoch **seconds** — Strava's unit, converted to ms at the storage boundary. */
  expires_at: number
  expires_in: number
  refresh_token: string
  access_token: string
  athlete?: StravaAthlete
}

export interface StravaAthlete {
  id: number
  username: string | null
  firstname: string | null
  lastname: string | null
  sex: string | null
  weight: number | null
  profile: string | null
  country: string | null
  city: string | null
  state: string | null
}

export interface StravaActivity {
  id: number
  athlete: { id: number }
  name: string
  sport_type: string
  type?: string
  start_date: string
  start_date_local: string
  timezone: string | null
  distance: number
  moving_time: number
  elapsed_time: number
  total_elevation_gain: number | null
  average_speed: number | null
  max_speed: number | null
  average_heartrate?: number | null
  max_heartrate?: number | null
  average_cadence?: number | null
  average_watts?: number | null
  suffer_score?: number | null
  start_latlng: [number, number] | null
  map?: { summary_polyline: string | null } | null
  [key: string]: unknown
}

export interface StravaLap {
  id: number
  lap_index: number
  name: string | null
  distance: number
  moving_time: number
  elapsed_time: number
  total_elevation_gain: number | null
  average_speed: number | null
  max_speed: number | null
  average_heartrate?: number | null
  max_heartrate?: number | null
  average_cadence?: number | null
  pace_zone?: number | null
  start_date: string
}

/** Payload Strava POSTs to the webhook callback. */
export interface StravaWebhookEvent {
  object_type: 'activity' | 'athlete'
  object_id: number
  aspect_type: 'create' | 'update' | 'delete'
  updates: Record<string, string>
  owner_id: number
  subscription_id: number
  /** Epoch seconds. */
  event_time: number
}
