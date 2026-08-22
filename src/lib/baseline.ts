import buildCsv from '../../docs/data/2025-26-build-activities.csv?raw'
import postRaceCsv from '../../docs/data/2026-post-race-activities.csv?raw'
import { BLOCK_START, RACE_DATE, weekIndex } from './block'
import type { Activity } from './db/schema'

/**
 * Last season, as data the app can compare against.
 *
 * The whole point of this block is to beat the one before it, and "beat" only means
 * something against a number. `docs/data/*.csv` already held that season — it was read
 * once, by hand, to write `docs/03`; this module hands the same rows to the app so the
 * comparison is drawn rather than remembered.
 *
 * The CSVs are imported `?raw` and parsed here rather than transcribed into a literal.
 * They are a finished, frozen record, so a copy would only ever be a second version of
 * the same fact — and the one that goes stale silently. Roughly 5 KB reaches the browser.
 *
 * Pure and browser-safe: no drizzle, no clock, no bindings.
 */

/** Sunday 18 Jan 2026 — La Mitja, the race this block is measured against. */
export const PREV_RACE_DATE = Date.UTC(2026, 0, 18)

/**
 * How far the previous season sits behind this one, so its rows can be laid over the
 * block directly.
 *
 * The two races are 371 days apart — 53 whole weeks — so shifting by this lands every
 * activity on the same weekday *and* the same distance from race day. That is the only
 * alignment that answers "am I ahead of where I was": week 12 of a 20-week build and
 * week 12 of a 23-week build are not the same place, but "eleven weeks out" always is.
 */
export const BASELINE_SHIFT_MS = RACE_DATE - PREV_RACE_DATE

interface Row {
  date: string
  name?: string
  sport: string
  dist: string
  time: string
  elev: string
  re: string
}

/**
 * Header-indexed, because the two files differ: the build export carries activity names
 * and the post-race one does not. No quoting to handle — no field in either file
 * contains a comma, and both are frozen.
 */
function parse(csv: string): Row[] {
  const lines = csv.trim().split('\n')
  const header = lines[0]!.split(',')
  return lines.slice(1).map((line) => {
    const cells = line.split(',')
    return Object.fromEntries(header.map((key, i) => [key, cells[i] ?? ''])) as unknown as Row
  })
}

/**
 * Historical rows wear the same shape as synced ones so every metric in `analytics.ts`
 * runs over either without a branch.
 *
 * Ids are negative: these rows never touch the database, and a negative id cannot collide
 * with a Strava one if a future export ever lands them in the same array.
 */
function toActivity(row: Row, index: number, shiftMs: number): Activity {
  const [year, month, day] = row.date.split('-').map(Number) as [number, number, number]
  return {
    id: -(index + 1),
    name: row.name?.trim() || row.sport,
    sportType: row.sport,
    // The export carries a date, not a time: midnight of the local day, which is the
    // wall clock every date in this app is stored as.
    startedOn: Date.UTC(year, month - 1, day) + shiftMs,
    distanceM: Number(row.dist),
    movingS: Number(row.time),
    elevationGainM: Number(row.elev),
    // The export has neither, and both are read as "unknown" everywhere downstream —
    // which is why the cadence comparison in the UI is this season only.
    averageHeartrate: null,
    maxHeartrate: null,
    cadenceSpm: null,
    sufferScore: Number(row.re) || null,
    updatedAt: 0,
  }
}

/** The same season on its own dates, for anything that has to say when it happened. */
export const BASELINE_RAW: Activity[] = parse(buildCsv).map((row, i) => toActivity(row, i, 0))

/**
 * The 2025-26 build, laid over this block: Sep 2025 – Jan 2026 read as Sep 2026 – Jan 2027.
 *
 * It covers block weeks 3–22 — that season's build was 20 weeks against this one's 23, so
 * the first three weeks have no counterpart. They are absent rather than zero, and every
 * chart here draws them that way.
 */
export const BASELINE: Activity[] = BASELINE_RAW.map((a) => ({
  ...a,
  startedOn: a.startedOn + BASELINE_SHIFT_MS,
}))

/**
 * What the block is walked into with. Jan–Aug 2026 was the injury, not a build, so these
 * rows are never compared against — they exist so the fitness curve does not open at zero
 * on 17 August, which would read as six weeks of gains that were really just the average
 * catching up with reality.
 */
export const PRE_BLOCK: Activity[] = parse(postRaceCsv)
  .map((row, i) => toActivity(row, i + BASELINE_RAW.length, 0))
  .filter((a) => a.startedOn < BLOCK_START)

/**
 * The first block week the baseline reaches. Before it there is nothing to compare with,
 * and a comparison drawn against nothing reads as a season that started at zero.
 */
export const BASELINE_FIRST_WEEK = Math.min(...BASELINE.map((a) => weekIndex(a.startedOn)))
