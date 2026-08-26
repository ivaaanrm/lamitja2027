import { describe, expect, it } from 'vitest'
import {
  BLOCK_START,
  DEFAULTS,
  GOAL_TIME_S,
  HR_MAX,
  PREV_RACE_DATE,
  RACE_DATE,
  RACE_DISTANCE_M,
  RACE_NAME,
  checkBlock,
  clock,
  isoDate,
  number,
  text,
} from '@/lib/config'
import { TOTAL_WEEKS } from '@/lib/block'
import { HR_MAX as HR_MAX_FROM_PACES, PACES } from '@/lib/paces'

/**
 * The helpers are tested with arguments rather than by moving `import.meta.env` around.
 * Vite substitutes `import.meta.env.PUBLIC_*` at build time, so there is nothing to
 * mutate at runtime — and a test that could mutate it would be testing the bundler.
 *
 * `checkBlock` is exported for the same reason: the cross-field rules are the ones that
 * turn a plausible `.env` into a plan for the wrong year, and a rule nobody can call is
 * a rule nobody can test.
 */

const DAY = 86_400_000
const MONDAY = Date.UTC(2026, 7, 17)

describe('the defaults are this repository’s block', () => {
  it('parses back to exactly the values the app shipped with', () => {
    // The whole promise of making the block configurable: with no `.env`, nothing moves.
    expect(text('PUBLIC_RACE_NAME', undefined, DEFAULTS.raceName)).toBe('La Mitja de Granollers')
    expect(isoDate('PUBLIC_BLOCK_START', undefined, DEFAULTS.blockStart)).toBe(Date.UTC(2026, 7, 17))
    expect(isoDate('PUBLIC_RACE_DATE', undefined, DEFAULTS.raceDate)).toBe(Date.UTC(2027, 0, 24))
    expect(isoDate('PUBLIC_PREV_RACE_DATE', undefined, DEFAULTS.prevRaceDate)).toBe(
      Date.UTC(2026, 0, 18),
    )
    expect(clock('PUBLIC_GOAL_TIME', undefined, DEFAULTS.goalTime)).toBe(4799)
    expect(number('PUBLIC_RACE_DISTANCE_M', undefined, DEFAULTS.raceDistanceM)).toBe(21097.5)
    expect(number('PUBLIC_HR_MAX', undefined, DEFAULTS.hrMax)).toBe(192)
  })

  it('passes its own validation', () => {
    expect(() =>
      checkBlock({
        blockStart: isoDate('PUBLIC_BLOCK_START', undefined, DEFAULTS.blockStart),
        raceDate: isoDate('PUBLIC_RACE_DATE', undefined, DEFAULTS.raceDate),
        prevRaceDate: isoDate('PUBLIC_PREV_RACE_DATE', undefined, DEFAULTS.prevRaceDate),
      }),
    ).not.toThrow()
  })
})

describe('the block the app actually runs on', () => {
  /**
   * The tests above prove the *helpers* read the defaults correctly. This one proves the
   * defaults reach the app: that `BLOCK_START` is wired to `PUBLIC_BLOCK_START` and not
   * to the race date, that `paces.ts` divides the goal by the race distance and not by
   * something else, that nothing was quietly renamed on the way through. A whole
   * indirection layer between a `.env` and the training maths can be green on every unit
   * of itself and still be plumbed to the wrong constant.
   *
   * These are assertions about the *example* block, exactly like `seed.test.ts`'s
   * `TOTAL_WEEKS === 23` — they hold because `vitest.config.ts` sets no `envPrefix` and
   * a fork's `.env` therefore does not reach the suite. Give it `envPrefix: 'PUBLIC_'`
   * and these fail on a fork, correctly, and belong with the example block when they do.
   */
  it('is this repository’s, with no `.env` anywhere', () => {
    expect(RACE_NAME).toBe('La Mitja de Granollers')
    expect(new Date(BLOCK_START).toISOString()).toBe('2026-08-17T00:00:00.000Z')
    expect(new Date(BLOCK_START).getUTCDay()).toBe(1) // Monday
    expect(new Date(RACE_DATE).toISOString()).toBe('2027-01-24T00:00:00.000Z')
    expect(new Date(RACE_DATE).getUTCDay()).toBe(0) // Sunday
    expect(new Date(PREV_RACE_DATE).toISOString()).toBe('2026-01-18T00:00:00.000Z')
    expect(TOTAL_WEEKS).toBe(23)
    expect(GOAL_TIME_S).toBe(4799)
    expect(RACE_DISTANCE_M).toBe(21_097.5)
    expect(HR_MAX).toBe(192)
    // `paces.ts` re-exports it so a caller wanting zones never has to know where the
    // number came from; the re-export has to still be the same number.
    expect(HR_MAX_FROM_PACES).toBe(192)
  })

  it('derives the six bands of docs/03 §4, to the second', () => {
    // `paces.test.ts` pins `bandsForGoalPace` at a goal pace it computes itself. This
    // pins the table the app is actually built with, which is the one a session card
    // reads — the ratios can be right and still be applied to the wrong goal.
    expect(PACES).toEqual({
      easy: { lo: 300, hi: 330 }, // 5:00–5:30
      long: { lo: 285, hi: 310 }, // 4:45–5:10
      steady: { lo: 260, hi: 275 }, // 4:20–4:35
      threshold: { lo: 230, hi: 238 }, // 3:50–3:58
      race: { lo: 225, hi: 227 }, // 3:45–3:47
      vo2: { lo: 210, hi: 220 }, // 3:30–3:40
    })
  })
})

describe('blank is absent', () => {
  it('falls back on an empty or whitespace-only value', () => {
    // `PUBLIC_HR_MAX=` in a `.env` is a line somebody meant to fill in, not the number
    // zero — and `Number('')` is 0, which would put every run in Z5 for ever.
    expect(number('PUBLIC_HR_MAX', '', 192)).toBe(192)
    expect(number('PUBLIC_HR_MAX', '   ', 192)).toBe(192)
    expect(isoDate('PUBLIC_RACE_DATE', '', '2027-01-24')).toBe(Date.UTC(2027, 0, 24))
    expect(clock('PUBLIC_GOAL_TIME', '', '1:19:59')).toBe(4799)
    expect(text('PUBLIC_RACE_NAME', '  ', 'La Mitja de Granollers')).toBe('La Mitja de Granollers')
  })

  it('trims a value that is really there', () => {
    expect(text('PUBLIC_RACE_NAME', '  Behobia  ', 'x')).toBe('Behobia')
    expect(number('PUBLIC_HR_MAX', ' 188 ', 192)).toBe(188)
  })
})

describe('isoDate', () => {
  it('reads YYYY-MM-DD as UTC midnight', () => {
    expect(isoDate('PUBLIC_RACE_DATE', '2027-01-24', '2027-01-24')).toBe(Date.UTC(2027, 0, 24))
    expect(new Date(isoDate('PUBLIC_BLOCK_START', '2026-08-17', 'x')).toISOString()).toBe(
      '2026-08-17T00:00:00.000Z',
    )
  })

  it('rejects anything that is not that shape, and names the variable', () => {
    for (const bad of ['24/01/2027', '2027-1-24', '2027-01-24T00:00:00Z', 'soon', '20270124']) {
      expect(() => isoDate('PUBLIC_RACE_DATE', bad, '2027-01-24'), bad).toThrow(
        /PUBLIC_RACE_DATE.*YYYY-MM-DD/,
      )
    }
  })

  it('rejects a day that does not exist, which Date.UTC would roll over instead', () => {
    // Date.UTC(2027, 1, 30) is 2 March. A block seeded against it would be silently
    // two days late for a race that never had a 30 February.
    expect(() => isoDate('PUBLIC_RACE_DATE', '2027-02-30', 'x')).toThrow(
      /PUBLIC_RACE_DATE.*not a real calendar day/,
    )
    expect(() => isoDate('PUBLIC_RACE_DATE', '2026-13-01', 'x')).toThrow(/not a real calendar day/)
    expect(() => isoDate('PUBLIC_RACE_DATE', '2027-00-10', 'x')).toThrow(/not a real calendar day/)
    // A leap day is real in 2028 and not in 2027.
    expect(isoDate('PUBLIC_RACE_DATE', '2028-02-29', 'x')).toBe(Date.UTC(2028, 1, 29))
    expect(() => isoDate('PUBLIC_RACE_DATE', '2027-02-29', 'x')).toThrow(/not a real calendar day/)
  })
})

describe('clock', () => {
  it('reads h:mm:ss and mm:ss into seconds', () => {
    expect(clock('PUBLIC_GOAL_TIME', '1:19:59', 'x')).toBe(4799)
    expect(clock('PUBLIC_GOAL_TIME', '3:05:00', 'x')).toBe(11_100)
    expect(clock('PUBLIC_GOAL_TIME', '36:15', 'x')).toBe(2175)
    // A leading field is a count, not a clock field: 95 minutes is a legitimate way to
    // write a 1:35 goal.
    expect(clock('PUBLIC_GOAL_TIME', '95:00', 'x')).toBe(5700)
  })

  it('rejects anything that is not a time, and names the variable', () => {
    for (const bad of ['79 min', '1:19:59.5', '4799', '1:19:59:00', '1::59', '']) {
      expect(() => clock('PUBLIC_GOAL_TIME', bad || undefined, 'nope'), bad).toThrow(
        /PUBLIC_GOAL_TIME/,
      )
    }
  })

  it('rejects a clock field that has run past 59', () => {
    expect(() => clock('PUBLIC_GOAL_TIME', '1:19:75', 'x')).toThrow(/PUBLIC_GOAL_TIME.*over 59/)
    expect(() => clock('PUBLIC_GOAL_TIME', '1:75:00', 'x')).toThrow(/over 59/)
  })

  it('rejects a goal of no time at all', () => {
    expect(() => clock('PUBLIC_GOAL_TIME', '0:00', 'x')).toThrow(
      /PUBLIC_GOAL_TIME must be longer than zero/,
    )
  })
})

describe('number', () => {
  it('takes a finite, positive measurement', () => {
    expect(number('PUBLIC_RACE_DISTANCE_M', '42195', 21097.5)).toBe(42195)
    expect(number('PUBLIC_RACE_DISTANCE_M', '21097.5', 0.1)).toBe(21097.5)
  })

  it('rejects what is not a number, and names the variable', () => {
    for (const bad of ['21,1 km', 'ten', 'NaN', 'Infinity']) {
      expect(() => number('PUBLIC_RACE_DISTANCE_M', bad, 21097.5), bad).toThrow(
        /PUBLIC_RACE_DISTANCE_M must be a number/,
      )
    }
  })

  it('rejects zero and negatives — every number here measures something', () => {
    expect(() => number('PUBLIC_HR_MAX', '0', 192)).toThrow(
      /PUBLIC_HR_MAX must be greater than zero/,
    )
    expect(() => number('PUBLIC_HR_MAX', '-5', 192)).toThrow(/greater than zero/)
  })
})

describe('text', () => {
  it('refuses a value that is empty on both sides', () => {
    expect(() => text('PUBLIC_RACE_NAME', '', '')).toThrow(/PUBLIC_RACE_NAME is empty/)
  })
})

describe('checkBlock', () => {
  const race = Date.UTC(2027, 0, 24)
  const prev = Date.UTC(2026, 0, 18)

  it('insists the block opens on a Monday', () => {
    // Week indices count from it, so a Tuesday start puts every week boundary mid-week.
    expect(() =>
      checkBlock({ blockStart: MONDAY + DAY, raceDate: race, prevRaceDate: prev }),
    ).toThrow(/PUBLIC_BLOCK_START must be a Monday/)
    expect(() => checkBlock({ blockStart: MONDAY, raceDate: race, prevRaceDate: prev })).not.toThrow()
  })

  it('insists race day comes after the block opens', () => {
    expect(() =>
      checkBlock({ blockStart: MONDAY, raceDate: MONDAY - DAY, prevRaceDate: prev }),
    ).toThrow(/PUBLIC_RACE_DATE must fall after PUBLIC_BLOCK_START/)
    expect(() => checkBlock({ blockStart: MONDAY, raceDate: MONDAY, prevRaceDate: prev })).toThrow(
      /PUBLIC_RACE_DATE must fall after PUBLIC_BLOCK_START/,
    )
  })

  it('insists on at least four weeks to train in', () => {
    expect(() =>
      checkBlock({ blockStart: MONDAY, raceDate: MONDAY + 20 * DAY, prevRaceDate: prev }),
    ).toThrow(/at least four weeks after PUBLIC_BLOCK_START/)
    // 22 days rounds up to four weeks — the shortest block the app will build.
    expect(() =>
      checkBlock({ blockStart: MONDAY, raceDate: MONDAY + 22 * DAY, prevRaceDate: prev }),
    ).not.toThrow()
  })

  it('insists last season’s race already happened', () => {
    // The baseline is laid over this block by shifting it *forward*.
    expect(() =>
      checkBlock({ blockStart: MONDAY, raceDate: race, prevRaceDate: race + DAY }),
    ).toThrow(/PUBLIC_PREV_RACE_DATE must fall before PUBLIC_RACE_DATE/)
  })
})
