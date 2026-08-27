import { describe, expect, it } from 'vitest'
import { DAY_MS, DEFAULT_BLOCK, WEEK_MS, totalWeeks } from '@/lib/block'
import { SESSION_META, isQuality } from '@/lib/plan'
import {
  buildPlan,
  hardShare,
  isDownWeek,
  phaseFor,
  resolvePhases,
  weeklyVolumeM,
  type SeedSession,
} from '@/lib/seed'
import { hardDistanceM, workoutDistanceM } from '@/lib/workout'

// The hand-written plan is the owner's block and no one else's — it is checked against
// those dates directly, the way docs/03 wrote them down.
const BLOCK_START = DEFAULT_BLOCK.startsOn
const RACE_DATE = DEFAULT_BLOCK.raceOn
const TOTAL_WEEKS = totalWeeks(DEFAULT_BLOCK)

const NOW = Date.UTC(2026, 7, 22)
const { weeks, sessions } = buildPlan(NOW)

const RUN = new Set(['easy', 'long', 'tempo', 'interval', 'fartlek', 'race'])

const weekOf = (at: number) => Math.floor((at - BLOCK_START) / WEEK_MS)
const byWeek = (week: number): SeedSession[] =>
  sessions.filter((s) => weekOf(s.scheduledOn) === week)

/** Every week's running sessions, the ones that carry a distance. */
const runsIn = (week: number) =>
  byWeek(week).filter((s) => RUN.has(s.type) && (s.targetDistanceM ?? 0) > 0)

const prescribedKm = (week: number) =>
  byWeek(week).reduce((sum, s) => sum + (SESSION_META[s.type].countsAsVolume ? (s.targetDistanceM ?? 0) : 0), 0) / 1000

describe('block shape', () => {
  it('covers the 23 weeks from Mon 17 Aug to race day', () => {
    // docs/03 says 22 weeks from 24 Aug; the block actually started a week earlier.
    expect(weeks).toHaveLength(23)
    expect(TOTAL_WEEKS).toBe(23)
  })

  it('follows the phase structure in docs/03 §2', () => {
    expect(phaseFor(0)).toBe('reconstrucción')
    expect(phaseFor(6)).toBe('reconstrucción')
    expect(phaseFor(7)).toBe('base')
    expect(phaseFor(13)).toBe('umbral')
    expect(phaseFor(18)).toBe('específico')
    expect(phaseFor(22)).toBe('puesta a punto')
  })

  it('resolves the phase shares to exactly docs/03 §2 at 23 weeks', () => {
    // The phases are shares of the block now, so that a fork of another length gets the
    // same proportions rather than a taper it never reaches. At this block's own length
    // the shares must land back on the week numbers the plan was written with — this is
    // the assertion that says the rewrite changed nothing.
    expect(resolvePhases(23).map((p) => [p.phase, p.from, p.to])).toEqual([
      ['reconstrucción', 0, 6],
      ['base', 7, 12],
      ['umbral', 13, 17],
      ['específico', 18, 20],
      ['puesta a punto', 21, 22],
    ])
  })

  it('keeps the phases well-formed at any block length', () => {
    for (const totalWeeks of [5, 6, 8, 12, 16, 20, 23, 26, 40]) {
      const spans = resolvePhases(totalWeeks)
      const at = `${totalWeeks} weeks`
      expect(spans, at).toHaveLength(5)
      expect(spans[0]!.from, at).toBe(0)
      expect(spans.at(-1)!.to, at).toBe(totalWeeks - 1)
      for (const [i, span] of spans.entries()) {
        // At least one week each, and no gaps or overlaps between them.
        expect(span.to, `${span.phase} at ${at}`).toBeGreaterThanOrEqual(span.from)
        if (i > 0) expect(span.from, `${span.phase} at ${at}`).toBe(spans[i - 1]!.to + 1)
      }
      // The order of the phases is the plan's argument; it never reshuffles.
      expect(spans.map((p) => p.phase), at).toEqual([
        'reconstrucción',
        'base',
        'umbral',
        'específico',
        'puesta a punto',
      ])
    }
  })

  it('drops the front of the plan rather than breaking on a block too short to hold it', () => {
    // Under five weeks there is no room for five phases. What a compressed block keeps is
    // the end of it — `config.ts` will not accept fewer than four weeks in any case.
    const spans = resolvePhases(4)
    expect(spans.map((p) => p.phase)).toEqual(['base', 'umbral', 'específico', 'puesta a punto'])
    expect(spans[0]!.from).toBe(0)
    expect(spans.at(-1)!.to).toBe(3)
  })

  it('never opens a phase on a cutback week', () => {
    // A down week is for absorbing the phase behind it, not for introducing the one
    // ahead — the step up in volume is what defines a new phase.
    for (const first of [0, 7, 13, 18, 21]) expect(isDownWeek(first), `week ${first}`).toBe(false)
  })

  it('ends on race day, over the full half marathon', () => {
    const race = sessions.find((s) => s.scheduledOn === RACE_DATE && s.type === 'race')!
    expect(race.title).toBe('La Mitja de Granollers')
    expect(race.steps!.some((step) => step.distanceM === 21097.5 && step.zone === 'race')).toBe(true)
    expect(race.targetPaceLoSKm).toBe(3 * 60 + 45)
  })
})

describe('volume', () => {
  it('peaks at 62 km — what 68 becomes on four runs a week', () => {
    // docs/03 §2 budgets 68 km at the peak over six runs. The week is four runs, so the
    // same figure would put 17 km on the average run; 62 km keeps the longest at 22.
    const peak = Math.max(...weeks.map((w) => w.targetVolumeM ?? 0))
    expect(peak / 1000).toBeCloseTo(62, 1)
  })

  it('totals roughly the ~935 km the plan budgets for', () => {
    const totalKm = weeks.reduce((sum, w) => sum + (w.targetVolumeM ?? 0), 0) / 1000
    // 41 km/wk against last block's 34 — docs/03 §2's ~965 was written for six runs a
    // week. A change that moves this by 5%+ means the ramp was altered by accident.
    expect(totalKm).toBeGreaterThan(890)
    expect(totalKm).toBeLessThan(980)
  })

  it('stores a target that the week’s own sessions actually add up to', () => {
    // The stored target is the sum of what is prescribed, not the ramp figure the easy
    // runs were sized from. A target no session adds up to stops meaning anything.
    for (let week = 0; week < TOTAL_WEEKS; week++) {
      expect(prescribedKm(week), `week ${week}`).toBeCloseTo((weeks[week]!.targetVolumeM ?? 0) / 1000, 3)
    }
  })

  it('lands on the ramp in every week but the last', () => {
    for (let week = 0; week < TOTAL_WEEKS - 1; week++) {
      expect(prescribedKm(week), `week ${week}`).toBeCloseTo(weeklyVolumeM(week) / 1000, 3)
    }
    // Race week is prescribed outright: the ramp says 28 km, of which the race is 21.1,
    // and seven kilometres across the six days before it is a shutdown, not a taper.
    expect(prescribedKm(TOTAL_WEEKS - 1)).toBeGreaterThan(34)
    expect(prescribedKm(TOTAL_WEEKS - 1)).toBeLessThan(42)
  })

  it('cuts down weeks to ~75%, following docs/03 §2', () => {
    // The fourth cutback sits at 15 rather than 16 so that it carries the December
    // control 10K: with four runs a week, a race week has only two flexible runs left.
    for (const week of [3, 8, 12, 15, 20]) expect(isDownWeek(week)).toBe(true)
    for (const week of [0, 4, 7, 13, 16, 17]) expect(isDownWeek(week)).toBe(false)

    // A down week must be lighter than the week before it — that is the whole point.
    for (const week of [3, 8, 12, 15, 20]) {
      expect(weeklyVolumeM(week), `week ${week}`).toBeLessThan(weeklyVolumeM(week - 1))
    }
  })

  it('never ramps more than 10% between consecutive build weeks', () => {
    // docs/02: the binding constraints are the knee and consistency. A ramp faster than
    // ~10% is the classic way to re-injure, so this must fail loudly if the curve changes.
    for (let week = 1; week < TOTAL_WEEKS; week++) {
      if (isDownWeek(week) || isDownWeek(week - 1)) continue // recovery and rebound are exempt
      const previous = weeklyVolumeM(week - 1)
      const growth = (weeklyVolumeM(week) - previous) / previous
      expect(growth, `week ${week}`).toBeLessThanOrEqual(0.1001)
    }
  })

  it('grows the long run without ever jumping it', () => {
    // Measured against the longest so far rather than last week's, because a checkpoint
    // race replaces the long run outright and a down week deliberately shortens it —
    // neither is a step backwards the next long run has to climb out of.
    const longRun = (week: number) =>
      Math.max(0, ...byWeek(week).filter((s) => s.type === 'long').map((s) => s.targetDistanceM ?? 0))

    expect(longRun(0) / 1000).toBe(8)
    expect(longRun(17) / 1000).toBe(22) // peak week
    expect(longRun(6), 'the Phase 0 gate replaces its long run').toBe(0)

    let ceiling = longRun(0) // the block opens where it opens; growth starts after it
    for (let week = 1; week < TOTAL_WEEKS; week++) {
      const distance = longRun(week)
      if (distance === 0 || isDownWeek(week)) continue
      expect(distance - ceiling, `week ${week}`).toBeLessThanOrEqual(3000)
      ceiling = Math.max(ceiling, distance)
    }
  })
})

describe('every session carries its variables', () => {
  it('gives every run a distance and a workout', () => {
    for (const session of sessions.filter((s) => RUN.has(s.type))) {
      expect(session.steps, session.id).not.toBeNull()
      expect(session.targetDistanceM, session.id).toBeGreaterThan(0)
      expect(session.targetDistanceM, session.id).toBe(workoutDistanceM(session.steps!))
    }
  })

  it('gives every rep set a count and a recovery', () => {
    const sets = sessions.flatMap((s) => (s.steps ?? []).filter((step) => step.kind === 'rep'))
    expect(sets.length).toBeGreaterThanOrEqual(15)
    for (const set of sets) {
      expect(set.reps).toBeGreaterThan(1)
      expect(set.recovery).not.toBeNull()
      expect(set.distanceM ?? set.durationS).toBeGreaterThan(0)
      expect(set.zone, 'a repetition without a pace is not a prescription').not.toBeNull()
    }
  })

  it('gives every quality session a pace band and a warm-up', () => {
    for (const session of sessions.filter((s) => isQuality(s.type))) {
      expect(session.targetPaceLoSKm, session.id).not.toBeNull()
      expect(session.targetPaceHiSKm, session.id).not.toBeNull()
      expect(session.steps![0]!.kind, session.id).toBe('warmup')
    }
  })

  it('measures strength and cross-training in minutes, never in kilometres', () => {
    for (const session of sessions.filter((s) => s.type === 'strength' || s.type === 'cross')) {
      expect(session.targetDurationS, session.id).toBeGreaterThan(0)
      expect(session.targetDistanceM, session.id).toBeNull()
    }
  })

  it('gives every session a stable, unique id so re-seeding updates in place', () => {
    const ids = sessions.map((s) => s.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(buildPlan(NOW + 5_000).sessions.map((s) => s.id)).toEqual(ids)
  })

  it('never puts a rest day on a day that already has a session', () => {
    for (const session of sessions.filter((s) => s.type === 'rest')) {
      const sameDay = sessions.filter((s) => s.scheduledOn === session.scheduledOn)
      expect(sameDay.map((s) => s.type), session.id).toEqual(['rest'])
    }
  })

  it('orders a double day so the run comes before the strength session', () => {
    const friday = byWeek(13).filter((s) => s.id.startsWith('w13-fri'))
    expect(friday.map((s) => s.type)).toEqual(['tempo', 'strength'])
    expect(friday.map((s) => s.dayOrder)).toEqual([0, 1])
  })
})

describe('intensity distribution', () => {
  it('runs the rebuild phase easy and by feel, up to the gate time trial', () => {
    // docs/03 §4: "In Phase 0, ignore all of these and run easy by feel."
    for (let week = 0; week <= 6; week++) {
      for (const session of byWeek(week)) {
        if (session.type === 'race') continue // the W7 gate is a test, not training
        expect(isQuality(session.type), `w${week} ${session.type}`).toBe(false)
        expect(session.targetPaceLoSKm, session.id).toBeNull()
      }
    }
  })

  it('keeps hard running under a quarter of the week until the race-specific phase', () => {
    // docs/03 §3: volume carries the load, quality does not. Hard metres are what is run
    // at threshold or faster — the warm-up and the recovery jogs of a rep session are not
    // quality, which is why this is not simply the distance of the quality sessions.
    for (let week = 0; week < 18; week++) {
      if (byWeek(week).some((s) => s.type === 'race')) continue // a race week is not a training week
      expect(hardShare(week), `week ${week}`).toBeLessThanOrEqual(0.25)
    }
    // Phase 3 is race-pace by design — docs/03 §2, "Everything at 3:47/km".
    for (const week of [18, 19, 21]) expect(hardShare(week), `week ${week}`).toBeLessThanOrEqual(0.35)
  })

  it('never puts two quality sessions on consecutive days', () => {
    // docs/03 §6: "Never two hard days back-to-back."
    const qualityDays = new Set(sessions.filter((s) => isQuality(s.type)).map((s) => s.scheduledOn))
    for (const day of qualityDays) {
      expect(qualityDays.has(day + DAY_MS), new Date(day).toISOString()).toBe(false)
    }
  })

  it('caps quality at two sessions a week', () => {
    for (let week = 0; week < TOTAL_WEEKS; week++) {
      expect(byWeek(week).filter((s) => isQuality(s.type)).length, `week ${week}`).toBeLessThanOrEqual(2)
    }
  })

  it('never adds volume and intensity in the same week', () => {
    // docs/03 §6. A week that both steps up and sharpens is how the knee went last time.
    for (let week = 1; week < TOTAL_WEEKS - 1; week++) {
      if (byWeek(week).some((s) => s.type === 'race')) continue // a race is a test, not a load
      // A cutback and the rebound out of it are exempt, exactly as they are for the growth
      // cap: a week that follows a cut necessarily grows, and — because a cutback also
      // drops a quality session — necessarily re-sharpens. That is a return to the trend,
      // not an addition to it.
      if (isDownWeek(week) || isDownWeek(week - 1)) continue
      const grew = weeklyVolumeM(week) > weeklyVolumeM(week - 1)
      const sharper = hardShare(week) > hardShare(week - 1) + 0.05
      expect(grew && sharper, `week ${week}`).toBe(false)
    }
  })
})

describe('frequency and strength', () => {
  it('runs exactly four times a week, every week of the block', () => {
    // The athlete trains four days plus one strength-only day. This is the constraint the
    // whole ramp is built around, so it must fail loudly rather than drift a run at a time.
    for (let week = 0; week < TOTAL_WEEKS; week++) {
      expect(runsIn(week).length, `week ${week}`).toBe(4)
    }
  })

  it('keeps the long run on Sunday', () => {
    for (const session of sessions.filter((s) => s.type === 'long')) {
      expect(new Date(session.scheduledOn).getUTCDay(), session.id).toBe(0)
    }
  })

  it('prescribes strength twice a week, every week up to race week', () => {
    // docs/03 §3: "One 17-minute session in the entire last block." Non-negotiable now.
    for (let week = 0; week < TOTAL_WEEKS - 1; week++) {
      expect(byWeek(week).filter((s) => s.type === 'strength'), `week ${week}`).toHaveLength(2)
    }
    // Race week keeps one, and it is mobility rather than load.
    expect(byWeek(TOTAL_WEEKS - 1).filter((s) => s.type === 'strength')).toHaveLength(1)
  })

  it('leaves two days a week empty, and never trains on a Saturday', () => {
    // Saturday off is the athlete's own rule, and it is what keeps the Sunday long run —
    // the session this plan is built on — off tired legs. Thursday is the other empty day:
    // docs/03 §6 calls cycling the pressure valve, and a valve opened every week by
    // prescription stops being one, so it lives in that day's note rather than as a row.
    for (let week = 0; week < TOTAL_WEEKS; week++) {
      expect(byWeek(week).filter((s) => s.type === 'rest'), `week ${week}`).toHaveLength(2)
    }
    const saturdays = sessions.filter((s) => new Date(s.scheduledOn).getUTCDay() === 6)
    // The one exception is the Tast, and that date belongs to the calendar, not the plan.
    for (const session of saturdays) {
      expect(['rest', 'race'], session.id).toContain(session.type)
    }
    expect(saturdays.filter((s) => s.type === 'race').map((s) => s.title)).toEqual([
      'Tast de la Mitja · 10K',
    ])
  })
})

describe('checkpoints', () => {
  const races = sessions.filter((s) => s.type === 'race')

  it('schedules all four checkpoints from docs/03 §5, plus the race', () => {
    expect(races.map((r) => weekOf(r.scheduledOn))).toEqual([6, 10, 15, 20, 22])
    // All but one land on a Sunday. The Tast is run on Saturday 31 Oct 2026 — a real date
    // on a real calendar, which is why that week rests on the Sunday instead.
    const [tast] = races.filter((r) => new Date(r.scheduledOn).getUTCDay() !== 0)
    expect(new Date(tast!.scheduledOn).toISOString().slice(0, 10)).toBe('2026-10-31')
    expect(races.filter((r) => r !== tast).every((r) => new Date(r.scheduledOn).getUTCDay() === 0)).toBe(true)
  })

  it('runs the Behobia as a long run, not as a race', () => {
    // The athlete has a dorsal on Sun 8 Nov 2026 and is running it as the week's tirada
    // larga. Typing it as a race would count all twenty kilometres as quality metres.
    const behobia = sessions.find((s) => s.title.startsWith('Behobia'))!
    expect(behobia.type).toBe('long')
    expect(new Date(behobia.scheduledOn).toISOString().slice(0, 10)).toBe('2026-11-08')
    expect(behobia.targetDistanceM).toBe(20000)
    expect(hardDistanceM(behobia.steps!)).toBe(0)
  })

  it('carries the marker pace each checkpoint has to hit', () => {
    // docs/03 §5, getting faster each time: 40:30 → 38:30 → 37:00 → 36:15.
    const markers = races.slice(0, 4).map((r) => r.targetPaceLoSKm!)
    for (let i = 1; i < markers.length; i++) expect(markers[i]!).toBeLessThan(markers[i - 1]!)
    // The race itself is 21.1 km, so its band is slower than any of the 10K markers.
    expect(races.at(-1)!.targetPaceLoSKm).toBe(3 * 60 + 45)
  })

  it('warms up and jogs down around every checkpoint', () => {
    for (const race of races.slice(0, 4)) {
      expect(race.steps![0]!.kind, race.id).toBe('warmup')
      expect(race.steps!.at(-1)!.kind, race.id).toBe('cooldown')
      expect(hardDistanceM(race.steps!), race.id).toBe(0) // a race carries no band; it is run flat out
    }
  })
})
