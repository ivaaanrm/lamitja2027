import { describe, expect, it } from 'vitest'
import { isRun } from '@/lib/activity'
import { BLOCK_START, RACE_DATE, TOTAL_WEEKS, WEEK_MS, weekIndex } from '@/lib/block'
import {
  BASELINE,
  BASELINE_FIRST_WEEK,
  BASELINE_RAW,
  BASELINE_SHIFT_MS,
  PRE_BLOCK,
  PREV_RACE_DATE,
} from '@/lib/baseline'

describe('the shift onto this block', () => {
  it('is a whole number of weeks, so every day keeps its weekday', () => {
    expect(BASELINE_SHIFT_MS % WEEK_MS).toBe(0)
    expect(BASELINE_SHIFT_MS / WEEK_MS).toBe(53)
  })

  it('lands last season’s race on this season’s race day', () => {
    expect(PREV_RACE_DATE + BASELINE_SHIFT_MS).toBe(RACE_DATE)
  })

  it('moves the rows and nothing else', () => {
    expect(BASELINE).toHaveLength(BASELINE_RAW.length)
    for (const [i, shifted] of BASELINE.entries()) {
      const raw = BASELINE_RAW[i]!
      expect(shifted.startedOn - raw.startedOn).toBe(BASELINE_SHIFT_MS)
      expect(shifted.distanceM).toBe(raw.distanceM)
      expect(shifted.sportType).toBe(raw.sportType)
    }
  })
})

describe('the 2025-26 build', () => {
  it('parses every row of the export', () => {
    // 82 activities, Sep 2025 through race day.
    expect(BASELINE_RAW.length).toBeGreaterThan(70)
    expect(BASELINE_RAW.every((a) => Number.isFinite(a.distanceM) && a.distanceM >= 0)).toBe(true)
    expect(BASELINE_RAW.every((a) => Number.isFinite(a.startedOn))).toBe(true)
  })

  it('lands entirely inside this block once shifted', () => {
    for (const activity of BASELINE) {
      expect(activity.startedOn).toBeGreaterThanOrEqual(BLOCK_START)
      expect(activity.startedOn).toBeLessThanOrEqual(RACE_DATE)
    }
  })

  it('opens three weeks in — a 20-week build against a 23-week one', () => {
    expect(BASELINE_FIRST_WEEK).toBe(3)
    expect(Math.max(...BASELINE.map((a) => weekIndex(a.startedOn)))).toBe(TOTAL_WEEKS - 1)
  })

  it('carries the sports the comparison depends on telling apart', () => {
    const sports = new Set(BASELINE_RAW.map((a) => a.sportType))
    expect(sports.has('Run')).toBe(true)
    expect(sports.has('Hike')).toBe(true)
    expect([...sports].filter((s) => isRun(s))).toEqual(['Run'])
  })

  it('keeps ids negative and unique, so they can never be mistaken for Strava rows', () => {
    const ids = [...BASELINE_RAW, ...PRE_BLOCK].map((a) => a.id)
    expect(ids.every((id) => id < 0)).toBe(true)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('reaches race day — the row every comparison is anchored on', () => {
    const race = BASELINE_RAW.find(
      (a) => a.startedOn === PREV_RACE_DATE && a.distanceM > 21_000,
    )
    expect(race).toBeDefined()
    expect(race!.movingS).toBe(5037)
  })
})

describe('the pre-block ramp', () => {
  it('is only what happened before the block opened', () => {
    expect(PRE_BLOCK.length).toBeGreaterThan(0)
    expect(PRE_BLOCK.every((a) => a.startedOn < BLOCK_START)).toBe(true)
  })

  it('reaches back far enough to run in a 42-day average', () => {
    const earliest = Math.min(...PRE_BLOCK.map((a) => a.startedOn))
    expect(BLOCK_START - earliest).toBeGreaterThan(42 * 86_400_000)
  })
})
