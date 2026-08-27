import { BLOCK_START, RACE_DATE, TOTAL_WEEKS, weekIndex } from './block'
import { PREV_RACE_DATE } from './config'
import type { Activity } from './db/schema'

/**
 * Last season, as data the app can compare against.
 *
 * The whole point of this block is to beat the one before it, and "beat" only means
 * something against a number. `docs/data/*.csv` already held that season — it was read
 * once, by hand, to write `docs/03`; this module hands the same rows to the app so the
 * comparison is drawn rather than remembered.
 *
 * The CSVs are read `?raw` and parsed here rather than transcribed into a literal. They
 * are a finished, frozen record, so a copy would only ever be a second version of the
 * same fact — and the one that goes stale silently. Roughly 5 KB reaches the browser.
 *
 * ## A fork's own history, or none at all
 *
 * The directory is read with `import.meta.glob` rather than by two named imports,
 * because a named import is a build error the moment the file is not there — and a fork
 * arrives with either its own exports or nothing. An empty `docs/data/` resolves to `{}`
 * and every export below degrades to an empty array, which is a season the app has no
 * counterpart for rather than a season that ran zero kilometres. The matched paths are
 * sorted so a second file cannot reorder the rows (and with them the negative ids)
 * between builds.
 *
 * Which file is which comes from the filename, and the convention is two words:
 *
 * - a name containing **`post-race`** is the run-in *before* the block — the weeks that
 *   have to be in the 42-day average on day one;
 * - otherwise, a name containing **`build`** is the previous season's build, the one the
 *   comparison is drawn against.
 *
 * `2025-26-build-activities.csv` and `2026-post-race-activities.csv` are this
 * repository's own, and they still match. Anything else in the directory is ignored:
 * `docs/data/` is also where a raw export lands on its way to being trimmed, and a file
 * the convention does not name is not a season.
 *
 * Columns are read by header name, not by position, because the two files do not carry
 * the same ones: `date,sport,dist,time,elev,re` in both, and `name` in the build export
 * only. `date` is `YYYY-MM-DD`.
 *
 * Pure and browser-safe: no drizzle, no clock, no bindings.
 */

const CSVS = import.meta.glob<string>('../../docs/data/*.csv', {
  query: '?raw',
  import: 'default',
  eager: true,
})

/**
 * Last season's race — Sunday 18 Jan 2026, La Mitja, by default. It is `config.ts` that
 * reads it now, and it is re-exported here because this is the module the alignment
 * belongs to: the date only means anything as one end of the shift below.
 */
export { PREV_RACE_DATE }

/**
 * How far the previous season sits behind this one, so its rows can be laid over the
 * block directly.
 *
 * The two races are 371 days apart — 53 whole weeks — so shifting by this lands every
 * activity on the same weekday *and* the same distance from race day. That is the only
 * alignment that answers "am I ahead of where I was": week 12 of a 20-week build and
 * week 12 of a 23-week build are not the same place, but "eleven weeks out" always is.
 *
 * Both dates come from `config.ts` now, and a fork's two races need not be a whole number
 * of weeks apart. The half of the alignment that matters survives either way — race day
 * still lands on race day — but the weekday half does not: with a shift that is not a
 * multiple of seven days, last season's Sunday long run lands on this season's Saturday.
 * Pointing `PUBLIC_PREV_RACE_DATE` at the previous edition of the same race, which is
 * what it is for, keeps both.
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
 * contains a comma, and both are frozen. A fork's own export has to hold to that.
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

/**
 * The two seasons the directory holds, split by the filename convention above and
 * flattened in sorted-path order — so a fork may split one season across several
 * exports, and a directory that holds neither kind gives back two empty lists.
 */
const { build: BUILD_ROWS, postRace: POST_RACE_ROWS } = (() => {
  const build: Row[] = []
  const postRace: Row[] = []
  for (const path of Object.keys(CSVS).sort()) {
    const name = path.slice(path.lastIndexOf('/') + 1)
    if (name.includes('post-race')) postRace.push(...parse(CSVS[path]!))
    else if (name.includes('build')) build.push(...parse(CSVS[path]!))
  }
  return { build, postRace }
})()

/** The same season on its own dates, for anything that has to say when it happened. */
export const BASELINE_RAW: Activity[] = BUILD_ROWS.map((row, i) => toActivity(row, i, 0))

/**
 * The previous build, laid over this block: with this repository's own data, Sep 2025 –
 * Jan 2026 read as Sep 2026 – Jan 2027.
 *
 * It covers block weeks 3–22 — that season's build was 20 weeks against this one's 23, so
 * the first three weeks have no counterpart. They are absent rather than zero, and every
 * chart here draws them that way; `BASELINE_FIRST_WEEK` below is where they end, and an
 * empty list is the degenerate case of exactly the same thing.
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
export const PRE_BLOCK: Activity[] = POST_RACE_ROWS.map((row, i) =>
  toActivity(row, i + BASELINE_RAW.length, 0),
).filter((a) => a.startedOn < BLOCK_START)

/**
 * The first block week the baseline reaches. Before it there is nothing to compare with,
 * and a comparison drawn against nothing reads as a season that started at zero.
 *
 * With no baseline at all it is `TOTAL_WEEKS`: a week the block never reaches, so every
 * `week >= BASELINE_FIRST_WEEK` test answers "not yet" for the whole block, which is the
 * truth. The spelt-out sentinel matters because the alternative is what `Math.min()` of
 * an empty list returns — `Infinity`, which orders correctly and then renders itself into
 * the sentence on `/progreso` as the word *Infinity*.
 *
 * The floor at zero is the same care at the other end. The shift lands last season's race
 * on this season's, so a previous build *longer* than this block — a 20-week baseline
 * against a 16-week fork — reaches back past `BLOCK_START` and its earliest rows carry a
 * negative week index. The first block week it reaches is still week 0, which is what
 * this constant is asked for, and week −43 is not a week anything can be said about.
 */
export const BASELINE_FIRST_WEEK =
  BASELINE.length === 0
    ? TOTAL_WEEKS
    : Math.max(0, Math.min(...BASELINE.map((a) => weekIndex(a.startedOn))))
