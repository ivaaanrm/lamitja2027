import { formatKm, isRun } from '@/lib/activity'
import { cn } from '@/lib/cn'
import { SESSION_META, type DayPlan, type SessionType, type WeekPlan } from '@/lib/plan'
import { ACCENT } from './ui'

/**
 * The week as a shape: seven columns, each the kilometres run standing in front of the
 * kilometres prescribed.
 *
 * Hand-rolled rather than a charting library. Seven bars is not enough data to justify
 * ~100 KB of Recharts, and this is a calendar first — weekday letters and a today marker
 * are things a chart component would fight rather than help with. The block-length trends
 * on `/progreso` went the same way in the end; `src/components/charts.tsx` has the reasons.
 *
 * Three decisions carry the whole strip:
 *
 *   **Soft is the plan, solid is what happened.** Every mark here is one of the two, so
 *   "has this day been run" is answered by fill against outline — geometry — and never by
 *   hue alone. A day half-run is a solid block with its own soft remainder above it, which
 *   is the reading a separate "done" glyph per column would have had to buy with a fourth
 *   row of elements.
 *
 *   **The hue is the session, not the state.** A column takes the colour its day's
 *   headline session takes everywhere else in the app (`ACCENT`), so Sunday's violet says
 *   *tirada larga* and Tuesday's coral says *series* before a word is read — which is the
 *   whole point of a week strip. A run nobody prescribed stays neutral: it happened, it
 *   just was not asked for.
 *
 *   **No numbers.** They used to sit under every column, and one card down `ThisWeek`
 *   prints the same distance per day beside the session that earned it. Seven duplicated
 *   figures at 11px is the cramped-screen failure the density rule names: the fix is
 *   fewer elements, so the strip is two per column — a block and a letter — and the bars
 *   get the height back. The figures survive for a screen reader in each column's label.
 *
 * A figure, not a control: what each day actually held is one tap away in `ThisWeek`'s
 * list, so a column that opened its own panel would be a second answer to a question
 * already on screen.
 */

const WEEKDAYS = ['L', 'M', 'X', 'J', 'V', 'S', 'D']

/** Bar track height in px. Fixed so the row keeps its shape on an empty week. */
const TRACK = 56

/** Dates are UTC midnight of the local day; formatting in the viewer's zone slides them. */
const dayFmt = new Intl.DateTimeFormat('es-ES', {
  weekday: 'long',
  day: 'numeric',
  timeZone: 'UTC',
})

interface DayStats {
  date: number
  actualM: number
  plannedM: number
  isToday: boolean
  /** The session that gives the day its colour, or `null` on a rest day. */
  headline: SessionType | null
  /** Every prescribed session on the day is behind you. */
  done: boolean
}

/**
 * The day's headline is the biggest thing on it: a long run beside a strength session is
 * a long-run day, not a strength one. Ties fall to the first, which `matchDay` has
 * already put in `dayOrder`.
 */
function headlineOf(day: DayPlan): SessionType | null {
  const prescribed = day.sessions.filter((m) => m.session.type !== 'rest')
  if (prescribed.length === 0) return null
  return prescribed.reduce((best, m) =>
    (m.session.targetDistanceM ?? 0) > (best.session.targetDistanceM ?? 0) ? m : best,
  ).session.type
}

function statsFor(day: DayPlan, today: number): DayStats {
  const runs = [
    ...day.sessions.map((m) => m.activity).filter((a) => a !== null),
    ...day.extras,
  ].filter((a) => isRun(a.sportType))

  const plannedM = day.sessions
    .filter((m) => SESSION_META[m.session.type].countsAsVolume)
    .reduce((sum, m) => sum + (m.session.targetDistanceM ?? 0), 0)

  const prescribed = day.sessions.filter((m) => m.session.type !== 'rest')

  return {
    date: day.date,
    actualM: runs.reduce((sum, a) => sum + a.distanceM, 0),
    plannedM,
    isToday: day.date === today,
    headline: headlineOf(day),
    done: prescribed.length > 0 && prescribed.every((m) => m.done),
  }
}

/**
 * What the column says out loud. The visible marks are `aria-hidden` behind `role="img"`,
 * so this sentence is the only thing a screen reader gets — it carries the distances the
 * strip stopped printing as well as the day and the kind of session.
 */
function describe(stats: DayStats): string {
  const day = dayFmt.format(new Date(stats.date))
  const kind = stats.headline ? SESSION_META[stats.headline].label : null

  let what: string
  if (stats.actualM > 0 && stats.plannedM > 0) {
    what = `${formatKm(stats.actualM)} km de ${formatKm(stats.plannedM)} km previstos`
  } else if (stats.actualM > 0) {
    what = `${formatKm(stats.actualM)} km sin planificar`
  } else if (stats.plannedM > 0) {
    what = `${formatKm(stats.plannedM)} km previstos, pendiente`
  } else if (kind) {
    what = stats.done ? 'hecho' : 'pendiente'
  } else {
    what = 'descanso'
  }

  return `${stats.isToday ? 'Hoy, ' : ''}${day}${kind ? ` · ${kind}` : ''}: ${what}`
}

export function WeekCalendar({
  week,
  today,
  className,
}: {
  week: WeekPlan
  /** UTC midnight of the current local day. */
  today: number
  className?: string
}) {
  const days = week.days.map((day) => statsFor(day, today))
  // Scale to the tallest thing in the week — planned or actual — so a big long run does
  // not flatten every other bar, and an overshoot still reads as an overshoot.
  const peak = Math.max(1000, ...days.map((d) => Math.max(d.actualM, d.plannedM)))

  return (
    <div className={cn('flex gap-1', className)}>
      {days.map((d, i) => (
        <DayColumn key={d.date} stats={d} weekday={WEEKDAYS[i]!} peak={peak} />
      ))}
    </div>
  )
}

function DayColumn({ stats, weekday, peak }: { stats: DayStats; weekday: string; peak: number }) {
  // Floored at 4% so a 2 km recovery jog beside a 20 km long run is still a block you can
  // see. `peak` is the week's own maximum, so nothing here can exceed 100.
  const actualPct = stats.actualM > 0 ? Math.max((stats.actualM / peak) * 100, 4) : 0
  const plannedPct = stats.plannedM > 0 ? Math.max((stats.plannedM / peak) * 100, 4) : 0
  const hasBars = stats.actualM > 0 || stats.plannedM > 0
  const accent = stats.headline ? ACCENT[stats.headline] : null

  return (
    // One `role="img"` per column rather than one for the whole strip: the label below is
    // then the day's own reading, and the marks inside stop being announced as a list of
    // empty spans. Nothing in here is focusable, so this costs no tab stops.
    <div
      role="img"
      aria-label={describe(stats)}
      className="flex min-w-0 flex-1 flex-col items-center gap-2"
    >
      <span className="relative w-3/5" style={{ height: TRACK }}>
        {/* Prescribed: the soft block the solid one grows into. Below target its own top
            edge is the target line, which is why no rule is drawn under it. */}
        {plannedPct > 0 ? (
          <span
            className={cn(
              'absolute inset-x-0 bottom-0 rounded-md ring-1 ring-inset',
              accent ? accent.chip : 'bg-fill ring-line',
            )}
            style={{ height: `${plannedPct}%` }}
          />
        ) : null}

        {/* Run. Neutral when nothing prescribed it — an unplanned run counts toward the
            week, but it does not get to claim a session's colour. */}
        {actualPct > 0 ? (
          <span
            className={cn(
              'absolute inset-x-0 bottom-0 rounded-md',
              accent ? accent.rail : 'bg-label-2',
            )}
            style={{ height: `${actualPct}%` }}
          />
        ) : null}

        {/* The target, drawn only once the solid block has swallowed it. An overshoot
            would otherwise read as merely "done" rather than as "over". */}
        {plannedPct > 0 && stats.actualM > stats.plannedM ? (
          <span
            aria-hidden
            className="absolute inset-x-0 border-t border-surface-deep/70"
            style={{ bottom: `${plannedPct}%` }}
          />
        ) : null}

        {/* Fuerza and cruzado are prescribed in minutes, so they raise no bar at all and
            used to leave the week's fifth session looking like a rest day. A stub in the
            same soft/solid grammar puts them back on the strip without pretending they
            carry kilometres. */}
        {!hasBars && accent ? (
          <span
            className={cn(
              'absolute inset-x-0 bottom-0 h-2.5 rounded-md',
              stats.done ? accent.rail : cn(accent.chip, 'ring-1 ring-inset'),
            )}
          />
        ) : null}

        {/* A day with nothing on it reads as deliberate, not as missing data. The same
            hairline marks a rest row in `ThisWeek`. */}
        {!hasBars && !accent ? (
          <span aria-hidden className="absolute inset-x-0 bottom-0 mx-auto h-px w-3 bg-fill-strong" />
        ) : null}
      </span>

      {/* The weekday carries the today marker on its own, so the day-of-month row this
          strip used to end with is one element the week no longer spends. */}
      <span
        className={cn(
          'flex size-5 items-center justify-center rounded-full text-caption2 uppercase',
          stats.isToday ? 'bg-accent font-semibold text-surface' : 'font-medium text-label-3',
        )}
      >
        {weekday}
      </span>
    </div>
  )
}
