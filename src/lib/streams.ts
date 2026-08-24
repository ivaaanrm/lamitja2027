import { hrZone, type Zone } from './paces'

/**
 * One activity, second by second — shaped for the detail view.
 *
 * The app stores summaries; the trace behind a run (pace, pulse, cadence, altitude over
 * distance) is fetched from Strava when the run is opened and never written down. A
 * stream is a few thousand samples, the detail view wants a few hundred pixels, and the
 * one question it answers — "what did this run look like?" — is one the summary already
 * answers for every chart on the other three tabs. So the raw samples are folded into
 * `POINTS` distance bins here, on the Worker, and the phone receives the bins.
 *
 * Pure: takes the streams Strava returned, imports nothing from `cloudflare:workers`,
 * and is unit-tested in plain Node.
 */

/** The streams the detail view asks for, `key_by_type=true`. Any of them can be absent. */
export interface StravaStreams {
  time?: { data: number[] }
  distance?: { data: number[] }
  heartrate?: { data: number[] }
  cadence?: { data: number[] }
  velocity_smooth?: { data: number[] }
  altitude?: { data: number[] }
}

/** The per-kilometre splits and laps on a detailed Strava activity. */
export interface StravaSplit {
  distance: number
  moving_time: number
  elapsed_time: number
  average_speed: number
  average_heartrate?: number | null
  elevation_difference?: number | null
}

export interface StravaLap {
  lap_index: number
  name?: string
  distance: number
  moving_time: number
  elapsed_time: number
  average_speed: number
  average_heartrate?: number | null
  max_heartrate?: number | null
  average_cadence?: number | null
  total_elevation_gain?: number | null
}

/** One distance bin of the trace. `null` where the sensor was missing or the watch was stopped. */
export interface TracePoint {
  /** Metres from the start, at the bin's far edge. */
  distanceM: number
  /** s/km, from smoothed velocity. `null` below walking pace — a pause, not a split. */
  paceSKm: number | null
  heartrate: number | null
  /** Steps per minute, already doubled from Strava's rpm. */
  cadenceSpm: number | null
  altitudeM: number | null
}

export interface Split {
  /** Metres covered — the last one is usually short. */
  distanceM: number
  movingS: number
  paceSKm: number
  heartrate: number | null
  elevationM: number | null
}

export interface Lap extends Split {
  index: number
  cadenceSpm: number | null
}

export interface ActivityDetail {
  trace: TracePoint[]
  /** Seconds in each heart-rate zone, from the trace. Empty without a strap. */
  zoneS: Record<Zone, number>
  splits: Split[]
  /** Only when the athlete pressed the lap button — one lap per activity is the split list again. */
  laps: Lap[]
  description: string | null
}

/** How many bins a trace is folded into — about one per 3 px across a phone. */
export const POINTS = 120

/** Below this the watch is paused or the runner is walking; either way it is not a pace. */
const MIN_SPEED_MS = 0.8

const mean = (values: number[]) =>
  values.length ? values.reduce((sum, v) => sum + v, 0) / values.length : null

/**
 * Where one sample of `values` sits on the distance stream's index space.
 *
 * Strava does not return every stream at the same sample count. GPS-derived streams
 * (`distance`, `altitude`) come back at the recording rate; a strap that reports every
 * few seconds, or a `velocity_smooth` the device computed at its own cadence, come back
 * shorter — the same run, sampled less often. `original_size` is per stream, not per
 * activity.
 *
 * Reading every stream at the distance stream's index `i` therefore did two wrong things
 * at once. Past the end of a shorter array `data[i]` is `undefined`, so its last fifth
 * simply vanished: on a 12 km run the pace and the pulse stopped at 9.7 km while the
 * altitude behind them ran the full width, which reads as a chart that gave up. Worse,
 * everything before that point was *shifted* — sample 1500 of a 3100-long strap stream is
 * the middle of the run, not the 1500th second of it — so the pulse shown at 5 km was the
 * pulse from 4 km, quietly and with no gap to give it away.
 *
 * Both go away by placing a sample proportionally: sample `j` of `length` is the same
 * fraction through the activity as index `j / (length - 1) * (distance.length - 1)` is
 * through the distance stream. When the two lengths match this is the identity, so a
 * device that samples everything at 1 Hz is binned exactly as before.
 */
const distanceAt = (j: number, length: number, distance: number[]) =>
  distance[length <= 1 ? 0 : Math.round((j / (length - 1)) * (distance.length - 1))]!

/**
 * Folds the streams into `points` equal distance bins.
 *
 * Distance rather than time on the x axis because a run is thought about in kilometres:
 * the splits underneath are per km, the plan prescribes metres, and a two-minute stop at
 * a crossing should not stretch the trace. Each bin reports the mean of the samples that
 * fell inside it; a bin with no samples (a GPS dropout) is a gap in the line, not a zero.
 *
 * Each stream is walked on its own index and placed by `distanceAt`, rather than all of
 * them being read off the distance stream's cursor — see there for what that cost.
 */
export function resample(streams: StravaStreams, points = POINTS): TracePoint[] {
  const distance = streams.distance?.data ?? []
  const total = distance.at(-1) ?? 0
  if (distance.length < 2 || total <= 0) return []

  const bins = Array.from({ length: points }, (_, i) => ({
    distanceM: ((i + 1) / points) * total,
    pace: [] as number[],
    hr: [] as number[],
    cad: [] as number[],
    alt: [] as number[],
  }))

  /** Drops every sample the caller has no use for, then bins the rest by where it was run. */
  const fold = (
    values: number[] | undefined,
    take: (value: number) => number | null,
    into: (bin: (typeof bins)[number]) => number[],
  ) => {
    if (!values?.length) return
    for (const [j, value] of values.entries()) {
      if (value == null) continue
      const kept = take(value)
      if (kept == null) continue
      const d = distanceAt(j, values.length, distance)
      into(bins[Math.min(points - 1, Math.floor((d / total) * points))]!).push(kept)
    }
  }

  // Below `MIN_SPEED_MS` the watch is paused or the runner is walking; either way it is
  // not a pace, and a zero would drag the bin's mean down rather than leave a gap.
  fold(streams.velocity_smooth?.data, (v) => (v >= MIN_SPEED_MS ? 1000 / v : null), (b) => b.pace)
  fold(streams.heartrate?.data, (hr) => (hr > 0 ? hr : null), (b) => b.hr)
  // Strava reports cadence in rpm; the app stores and renders spm. 85 rpm is 170 pasos/min.
  fold(streams.cadence?.data, (cad) => (cad > 0 ? cad * 2 : null), (b) => b.cad)
  fold(streams.altitude?.data, (alt) => alt, (b) => b.alt)

  return bins.map((bin) => ({
    distanceM: Math.round(bin.distanceM),
    paceSKm: round(mean(bin.pace)),
    heartrate: round(mean(bin.hr)),
    cadenceSpm: round(mean(bin.cad)),
    altitudeM: round(mean(bin.alt)),
  }))
}

const round = (value: number | null) => (value == null ? null : Math.round(value))

/**
 * Seconds spent in each zone, sample by sample. Each sample owns the interval since the
 * one before it, so a strap that reported every 3 s weighs the same as one every second.
 *
 * The strap and the clock are read on their own indices for the reason `distanceAt`
 * explains. Walking both to `Math.min(time.length, hr.length)` — which is what this did —
 * stopped at whichever ran out first and charged every zone the *clock's* interval at the
 * strap's index, so a strap sampling at 4/5 the recording rate reported four fifths of a
 * run and called it the whole thing. The shares underneath the trace were then a
 * percentage of a number that was itself short.
 */
export function timeInZones(streams: StravaStreams): Record<Zone, number> {
  const out: Record<Zone, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 }
  const time = streams.time?.data ?? []
  const hr = streams.heartrate?.data ?? []
  if (time.length < 2 || hr.length < 2) return out

  // When the two lengths match this is `time[j]`, so a 1 Hz device is unaffected.
  const clock = (j: number) => time[Math.round((j / (hr.length - 1)) * (time.length - 1))]!

  for (let j = 1; j < hr.length; j++) {
    const bpm = hr[j]!
    if (bpm > 0) out[hrZone(bpm)] += clock(j) - clock(j - 1)
  }
  return out
}

export function toSplit(split: StravaSplit): Split {
  return {
    distanceM: split.distance,
    movingS: split.moving_time,
    paceSKm: split.average_speed > 0 ? 1000 / split.average_speed : 0,
    heartrate: split.average_heartrate == null ? null : Math.round(split.average_heartrate),
    elevationM: split.elevation_difference ?? null,
  }
}

export function toLap(lap: StravaLap): Lap {
  return {
    ...toSplit({ ...lap, elevation_difference: lap.total_elevation_gain }),
    index: lap.lap_index,
    cadenceSpm: lap.average_cadence == null ? null : Math.round(lap.average_cadence * 2),
  }
}

/**
 * Whether the laps carry anything the splits do not. Strava emits one lap for every
 * activity, and a watch set to auto-lap emits one per kilometre — both would only repeat
 * the split table. Laps are worth a table of their own when the athlete pressed the
 * button: a series session, where the reps are the point.
 */
function isPressed(laps: Lap[]): boolean {
  if (laps.length < 2) return false
  return !laps.slice(0, -1).every((lap) => Math.abs(lap.distanceM - 1000) < 50)
}

export function buildDetail(
  streams: StravaStreams,
  activity: { splits_metric?: StravaSplit[]; laps?: StravaLap[]; description?: string | null },
): ActivityDetail {
  const laps = (activity.laps ?? []).map(toLap)
  return {
    trace: resample(streams),
    zoneS: timeInZones(streams),
    splits: (activity.splits_metric ?? []).map(toSplit),
    laps: isPressed(laps) ? laps : [],
    description: activity.description?.trim() || null,
  }
}
