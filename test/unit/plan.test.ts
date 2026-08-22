import { describe, expect, it } from 'vitest'
import { BLOCK_START, DAY_MS } from '@/lib/block'
import { buildWeek, matchDay, weekDays, weekStart } from '@/lib/plan'
import type { Activity, PlanSession } from '@/lib/db/schema'

const MONDAY = BLOCK_START
let nextId = 1

function activity(overrides: Partial<Activity> = {}): Activity {
  return {
    id: nextId++,
    name: 'Run',
    sportType: 'Run',
    startedOn: MONDAY + 8 * 3_600_000,
    distanceM: 10_000,
    movingS: 3_000,
    elevationGainM: 20,
    averageHeartrate: 150,
    maxHeartrate: 170,
    cadenceSpm: 170,
    sufferScore: 40,
    updatedAt: 0,
    ...overrides,
  }
}

function session(overrides: Partial<PlanSession> = {}): PlanSession {
  return {
    id: `s${nextId++}`,
    scheduledOn: MONDAY,
    dayOrder: 0,
    type: 'easy',
    title: 'Easy',
    notes: null,
    steps: null,
    targetDistanceM: null,
    targetDurationS: null,
    targetPaceLoSKm: null,
    targetPaceHiSKm: null,
    doneAt: null,
    activityId: null,
    updatedAt: 0,
    ...overrides,
  }
}

describe('matchDay', () => {
  it('settles a run session with the run that answered it', () => {
    const run = activity()
    const day = matchDay(MONDAY, [session()], [run])

    expect(day.sessions[0]!.activity).toBe(run)
    expect(day.sessions[0]!.done).toBe(true)
    expect(day.extras).toEqual([])
  })

  it('honours an explicit link even when another activity is the closer fit', () => {
    // The escape hatch for the days the heuristic guesses wrong: a pinned id must never
    // be stolen by a session whose target happens to sit nearer.
    const short = activity({ distanceM: 5_000 })
    const long = activity({ distanceM: 20_000 })
    const pinned = session({ targetDistanceM: 5_000, activityId: long.id })

    const day = matchDay(MONDAY, [pinned], [short, long])
    expect(day.sessions[0]!.activity).toBe(long)
    expect(day.extras).toEqual([short])
  })

  it('gives each session of a double day the activity nearest its target', () => {
    const easy = activity({ distanceM: 8_000 })
    const workout = activity({ distanceM: 14_000 })
    const day = matchDay(
      MONDAY,
      [
        session({ id: 'a', dayOrder: 0, targetDistanceM: 15_000, type: 'long' }),
        session({ id: 'b', dayOrder: 1, targetDistanceM: 8_000 }),
      ],
      [easy, workout],
    )

    expect(day.sessions.find((s) => s.session.id === 'a')!.activity).toBe(workout)
    expect(day.sessions.find((s) => s.session.id === 'b')!.activity).toBe(easy)
  })

  it('takes the longest effort when a session names no target', () => {
    const short = activity({ distanceM: 4_000 })
    const long = activity({ distanceM: 12_000 })
    const day = matchDay(MONDAY, [session()], [short, long])

    expect(day.sessions[0]!.activity).toBe(long)
    expect(day.extras).toEqual([short])
  })

  it('never crosses sport families', () => {
    const gym = activity({ sportType: 'WeightTraining', distanceM: 0 })
    const ride = activity({ sportType: 'Ride', distanceM: 30_000 })
    const day = matchDay(
      MONDAY,
      [session({ id: 'run', type: 'easy' }), session({ id: 'gym', type: 'strength' })],
      [gym, ride],
    )

    expect(day.sessions.find((s) => s.session.id === 'gym')!.activity).toBe(gym)
    // No run happened, so the run session stays open and the ride is left unclaimed.
    expect(day.sessions.find((s) => s.session.id === 'run')!.activity).toBeNull()
    expect(day.extras).toEqual([ride])
  })

  it('leaves a rest day unclaimed, so the run still shows as unplanned', () => {
    const run = activity()
    const day = matchDay(MONDAY, [session({ type: 'rest', title: 'Rest' })], [run])

    expect(day.sessions[0]!.activity).toBeNull()
    expect(day.sessions[0]!.done).toBe(false)
    expect(day.extras).toEqual([run])
  })

  it('counts a hand-ticked session as done with nothing in Strava', () => {
    // How strength and cross sessions are completed — they never produce an activity.
    const day = matchDay(MONDAY, [session({ type: 'strength', doneAt: 123 })], [])
    expect(day.sessions[0]!.done).toBe(true)
    expect(day.sessions[0]!.activity).toBeNull()
  })
})

describe('weekDays', () => {
  it('runs Monday to Sunday from the block start', () => {
    const days = weekDays(2)
    expect(days).toHaveLength(7)
    expect(days[0]).toBe(weekStart(2))
    expect(new Date(days[0]!).getUTCDay()).toBe(1)
    expect(days[6]! - days[0]!).toBe(6 * DAY_MS)
  })
})

describe('buildWeek', () => {
  it('always yields seven days, empty ones included', () => {
    const week = buildWeek(0, [], [session()], [activity()])
    expect(week.days).toHaveLength(7)
    expect(week.days.map((d) => d.date)).toEqual(weekDays(0))
  })

  it('files each session and activity under the day it happened', () => {
    const wednesday = MONDAY + 2 * DAY_MS
    const week = buildWeek(
      0,
      [],
      [session({ scheduledOn: wednesday })],
      [activity({ startedOn: wednesday + 7 * 3_600_000 })],
    )

    expect(week.days[0]!.sessions).toEqual([])
    expect(week.days[2]!.sessions).toHaveLength(1)
    expect(week.days[2]!.sessions[0]!.done).toBe(true)
    expect(week.extras).toEqual([])
  })

  it('surfaces a run on an unplanned day rather than dropping it', () => {
    const friday = MONDAY + 4 * DAY_MS
    const week = buildWeek(0, [], [], [activity({ startedOn: friday })])

    expect(week.sessions).toEqual([])
    expect(week.extras).toHaveLength(1)
  })
})
