import { describe, expect, it } from 'vitest'
import { type BlockConfig, DAY_MS, DEFAULT_BLOCK, WEEK_MS, weekDays } from '@/lib/block'
import { buildBlock, buildWeek, effortLabel, matchDay, sessionEffort } from '@/lib/plan'
import type { Activity, PlanSession } from '@/lib/db/schema'
import { PACES } from '@/lib/paces'
import { cooldown, jogFor, km, reps, steady, warmup } from '@/lib/workout'

const BLOCK = DEFAULT_BLOCK
const MONDAY = BLOCK.startsOn
let nextId = 1

function activity(overrides: Partial<Activity> = {}): Activity {
  return {
    id: nextId++,
    userId: 'owner',
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
    userId: 'owner',
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

describe('buildWeek', () => {
  it('always yields seven days, empty ones included', () => {
    const week = buildWeek(BLOCK, 0, [], [session()], [activity()])
    expect(week.days).toHaveLength(7)
    expect(week.days.map((d) => d.date)).toEqual(weekDays(BLOCK, 0))
  })

  it('files each session and activity under the day it happened', () => {
    const wednesday = MONDAY + 2 * DAY_MS
    const week = buildWeek(
      BLOCK,
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
    const week = buildWeek(BLOCK, 0, [], [], [activity({ startedOn: friday })])

    expect(week.sessions).toEqual([])
    expect(week.extras).toHaveLength(1)
  })
})

describe('buildBlock', () => {
  /** A second athlete: ten weeks to a 10K, opening three weeks after the owner's block. */
  const OTHER: BlockConfig = {
    startsOn: Date.UTC(2026, 8, 7),
    raceOn: Date.UTC(2026, 10, 15),
    goalTimeS: 2400,
    raceDistanceM: 10_000,
    raceName: 'Cursa dels Nassos',
    racePlace: null,
  }

  it('spans as many weeks as the block it is handed', () => {
    expect(buildBlock(BLOCK, [], [], [])).toHaveLength(23)
    expect(buildBlock(OTHER, [], [], [])).toHaveLength(10)
  })

  it('files a session by the week of the block it was given, not of the owner’s', () => {
    // The same Monday is week 3 for the owner and week 0 for the other athlete. Reading it
    // off a compiled-in start is exactly the bug the block value exists to make impossible.
    const at = BLOCK.startsOn + 3 * WEEK_MS
    const own = buildBlock(BLOCK, [], [session({ scheduledOn: at })], [])
    const other = buildBlock(OTHER, [], [session({ scheduledOn: at })], [])

    expect(own[3]!.sessions).toHaveLength(1)
    expect(own[0]!.sessions).toEqual([])
    expect(other[0]!.sessions).toHaveLength(1)
    expect(other[0]!.startsOn).toBe(OTHER.startsOn)
  })
})

describe('sessionEffort', () => {
  it('prefers the session\'s own band over the one its steps imply', () => {
    // A race is the case that matters: the steps say `race`, but the marker pace the
    // checkpoint is measured against is the number that was typed on the session.
    const effort = sessionEffort(
      session({
        steps: [warmup(km(3)), steady(km(10), 'race'), cooldown(km(2))],
        targetPaceLoSKm: 238,
        targetPaceHiSKm: 248,
      }),
    )
    expect(effort.band).toEqual({ lo: 238, hi: 248 })
    // No zone: a hand-typed pace is a number, and calling it Z4 would be the app guessing.
    expect(effort.zone).toBeNull()
    expect(effortLabel(effort)).toBe('3:58–4:08/km')
  })

  it('falls back to the band the steps are run at', () => {
    const effort = sessionEffort(
      session({
        steps: [warmup(km(2)), reps(5, { distanceM: 1000 }, 'vo2', jogFor(90)), cooldown(km(2))],
        targetDistanceM: 10_000,
      }),
    )
    expect(effort.zone).toBe('vo2')
    expect(effort.band).toEqual(PACES.vo2)
    expect(effortLabel(effort)).toBe('Z5 · 3:30–3:40/km')
  })

  it('reads a single bound as a band, so a half-filled edit still says something', () => {
    const effort = sessionEffort(session({ targetPaceLoSKm: 227, targetDistanceM: 10_000 }))
    expect(effort.band).toEqual({ lo: 227, hi: 227 })
    expect(effortLabel(effort)).toBe('3:47/km')
  })

  it('says by feel when the plan prescribes no band at all — Phase 0, on purpose', () => {
    const effort = sessionEffort(
      session({ steps: [steady(km(9), null)], targetDistanceM: 9_000 }),
    )
    expect(effort.band).toBeNull()
    expect(effortLabel(effort)).toBe('A sensaciones')
  })

  it('estimates a step-less session from its distance at mid-band', () => {
    const effort = sessionEffort(
      session({ targetDistanceM: 10_000, targetPaceLoSKm: 285, targetPaceHiSKm: 315 }),
    )
    expect(effort.estimateS).toBe(3000)
  })

  it('leaves a session measured in minutes without an estimate', () => {
    // Strength carries a prescribed duration, not a derived one — printing it as ≈ 35m
    // would dress a number that was written down as one the app worked out.
    const effort = sessionEffort(session({ type: 'strength', targetDurationS: 2100 }))
    expect(effort.estimateS).toBeNull()
    expect(effort.band).toBeNull()
  })
})
