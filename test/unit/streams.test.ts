import { describe, expect, it } from 'vitest'
import { buildDetail, resample, timeInZones, toLap, type StravaStreams } from '@/lib/streams'

/** A 2 km run at 3.0 m/s, one sample a second, 160 bpm rising to 180, 85 rpm. */
function streams(seconds = 667): StravaStreams {
  const n = seconds
  return {
    time: { data: Array.from({ length: n }, (_, i) => i) },
    distance: { data: Array.from({ length: n }, (_, i) => i * 3) },
    velocity_smooth: { data: Array.from({ length: n }, () => 3) },
    heartrate: { data: Array.from({ length: n }, (_, i) => 160 + Math.round((i / n) * 20)) },
    cadence: { data: Array.from({ length: n }, () => 85) },
    altitude: { data: Array.from({ length: n }, (_, i) => 100 + i / 10) },
  }
}

describe('resample', () => {
  it('folds the streams into the requested number of distance bins', () => {
    const trace = resample(streams(), 10)
    expect(trace).toHaveLength(10)
    expect(trace.at(-1)!.distanceM).toBe(666 * 3)
    expect(trace[0]!.distanceM).toBeCloseTo(666 * 3 * 0.1, 0)
  })

  it('converts velocity to s/km and rpm to spm', () => {
    const [point] = resample(streams(), 10)
    expect(point!.paceSKm).toBe(333) // 1000 / 3
    expect(point!.cadenceSpm).toBe(170)
    expect(point!.heartrate).toBeGreaterThanOrEqual(160)
    expect(point!.altitudeM).toBe(103)
  })

  it('treats a stopped watch as a gap, not a pace', () => {
    const s = streams()
    s.velocity_smooth!.data.fill(0, 0, 100)
    const trace = resample(s, 10)
    expect(trace[0]!.paceSKm).toBeNull()
    expect(trace[5]!.paceSKm).toBe(333)
  })

  it('leaves a missing sensor null without dropping the bin', () => {
    const s = streams()
    delete s.heartrate
    const trace = resample(s, 10)
    expect(trace).toHaveLength(10)
    expect(trace.every((p) => p.heartrate === null)).toBe(true)
  })

  it('is empty for an activity with no distance stream', () => {
    expect(resample({ time: { data: [0, 1, 2] } })).toEqual([])
  })
})

describe('timeInZones', () => {
  it('charges each sample with the interval since the one before it', () => {
    const zones = timeInZones({
      time: { data: [0, 3, 6, 9] },
      heartrate: { data: [100, 100, 180, 180] }, // Z1, Z1, Z5, Z5
    })
    expect(zones[1]).toBe(3)
    expect(zones[5]).toBe(6)
    expect(zones[2] + zones[3] + zones[4]).toBe(0)
  })

  it('adds up to the elapsed time', () => {
    const zones = timeInZones(streams())
    expect(Object.values(zones).reduce((a, b) => a + b, 0)).toBe(666)
  })
})

describe('buildDetail', () => {
  const lap = (lap_index: number) => ({
    lap_index,
    distance: 1000,
    moving_time: 230,
    elapsed_time: 235,
    average_speed: 1000 / 230,
    average_heartrate: 171.4,
    average_cadence: 88,
    total_elevation_gain: 4,
  })

  it('maps laps to spm and s/km', () => {
    expect(toLap(lap(1))).toMatchObject({ index: 1, cadenceSpm: 176, heartrate: 171, elevationM: 4 })
    expect(toLap(lap(1)).paceSKm).toBeCloseTo(230)
  })

  it('keeps laps only when the athlete pressed the button', () => {
    // One lap per activity, and one per kilometre from auto-lap, both repeat the splits.
    expect(buildDetail(streams(), { laps: [lap(1)] }).laps).toEqual([])
    const auto = [lap(1), lap(2), { ...lap(3), distance: 412 }]
    expect(buildDetail(streams(), { laps: auto }).laps).toEqual([])
    const reps = [lap(1), { ...lap(2), distance: 400 }, { ...lap(3), distance: 1200 }]
    expect(buildDetail(streams(), { laps: reps }).laps).toHaveLength(3)
  })

  it('trims an empty description to null', () => {
    expect(buildDetail({}, { description: '  ' }).description).toBeNull()
    expect(buildDetail({}, { description: 'Rodilla bien.' }).description).toBe('Rodilla bien.')
  })
})
