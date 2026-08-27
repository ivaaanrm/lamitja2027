import { totalWeeks, weekIndex, type BlockConfig } from './block'
import { PREV_RACE_DATE } from './config'
import type { Activity } from './db/schema'

/**
 * Last season, as data the app can compare against.
 *
 * The whole point of this block is to beat the one before it, and "beat" only means
 * something against a number. `docs/personal/data/*.csv` already held that season — it was read
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
 * arrives with either its own exports or nothing. An absent `docs/personal/data/` resolves to `{}`
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
 * The directory is **`docs/personal/data/`**, and `docs/personal/` is gitignored: it is
 * one athlete's six-year Strava record and it does not belong in a public repository. So
 * the common case for anyone who clones this is that the glob matches nothing and every
 * comparison against last season reads as absent — which is correct, and is why the
 * absence has to be a supported state rather than a build error. Drop your own exports in
 * to get the comparison back. Anything the convention does not name is ignored: that
 * directory is also where a raw export lands on its way to being trimmed.
 *
 * Columns are read by header name, not by position, because the two files do not carry
 * the same ones: `date,sport,dist,time,elev,re` in both, and `name` in the build export
 * only. `date` is `YYYY-MM-DD`.
 *
 * Pure and browser-safe: no drizzle, no clock, no bindings.
 */

const CSVS = import.meta.glob<string>('../../docs/personal/data/*.csv', {
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
 * The key an athlete carries on `users.baseline_key` to be handed this season.
 *
 * These CSVs are one person's history, so the comparison is a property of the athlete
 * rather than of the app: everyone else gets null, and null is drawn as absent — the same
 * way the first three weeks of this block are.
 */
export const BASELINE_KEY = 'ivan-2025-26'

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
/**
 * How far last season sits behind a given block, so its rows can be laid over it directly.
 *
 * A function rather than a constant now: the owner can move their race date on `/ajustes`,
 * and a shift computed once at module load would quietly leave the overlay a fortnight out.
 * Point `PUBLIC_PREV_RACE_DATE` at the previous edition of the same race and this stays a
 * whole number of weeks, which is what keeps every row on the same weekday as well as the
 * same distance from race day.
 */
export const baselineShiftMs = (block: BlockConfig) => block.raceOn - PREV_RACE_DATE

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
 *
 * `userId` is the season's key rather than a uuid for the same reason: `activities.user_id`
 * is now notNull, these rows are never inserted, and a slug can never be mistaken for the
 * id of an athlete who actually exists.
 */
function toActivity(row: Row, index: number, shiftMs: number): Activity {
  const [year, month, day] = row.date.split('-').map(Number) as [number, number, number]
  return {
    id: -(index + 1),
    userId: BASELINE_KEY,
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

const PRE_BLOCK_RAW: Activity[] = POST_RACE_ROWS.map((row, i) =>
  toActivity(row, i + BASELINE_RAW.length, 0),
)

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
export interface Baseline {
  /** Last season's build, shifted onto this block. */
  activities: Activity[]
  /** The run-in before it opened — never compared against, only run into the averages. */
  preBlock: Activity[]
  /** The first block week the baseline reaches; `totalWeeks` when there is none. */
  firstWeek: number
  /** What the rows were moved by, for anything that has to say when one really happened. */
  shiftMs: number
}

/**
 * The previous season, laid over one athlete's block — or `null`, which is what every
 * athlete but the owner gets.
 *
 * `docs/personal/data/*.csv` is one person's Strava export. Handing it to everybody would draw a
 * stranger's 2025-26 build across their charts and label it *la temporada pasada*, so it
 * is gated on `users.baseline_key` and nothing else: a column only the owner row carries.
 * A fork with its own CSVs points its own owner at them by keeping the same key.
 */
export function baselineFor(key: string | null, block: BlockConfig): Baseline | null {
  if (key !== BASELINE_KEY || BASELINE_RAW.length === 0) return null

  const shiftMs = baselineShiftMs(block)
  const activities = BASELINE_RAW.map((a) => ({ ...a, startedOn: a.startedOn + shiftMs }))
  return {
    activities,
    preBlock: PRE_BLOCK_RAW.filter((a) => a.startedOn < block.startsOn),
    firstWeek: Math.max(0, Math.min(...activities.map((a) => weekIndex(block, a.startedOn)))),
    shiftMs,
  }
}
