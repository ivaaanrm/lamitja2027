import { formatKm, isRun } from '@/lib/activity'
import { cn } from '@/lib/cn'
import { SESSION_META, isQuality, type DayPlan, type WeekPlan } from '@/lib/plan'

/**
 * The week at a glance: seven days, each a bar of kilometres run against a ghost bar of
 * what was prescribed.
 *
 * Hand-rolled rather than a charting library. Seven bars is not enough data to justify
 * ~100 KB of Recharts, and this is a calendar first — weekday headers and a today marker
 * are things a chart component would fight rather than help with. The block-length trends
 * on `/progreso` went the same way in the end; `src/components/charts.tsx` has the reasons.
 *
 * A figure, not a control: what each day actually held is one line down the page in
 * `ThisWeek`, so a bar that opened its own panel would be a second answer to a question
 * already on screen.
 */

const WEEKDAYS = ['L', 'M', 'X', 'J', 'V', 'S', 'D']

/** Bar track height in px. Fixed so the row keeps its shape on an empty week. */
const TRACK = 52

interface DayStats {
  date: number
  actualM: number
  plannedM: number
  isToday: boolean
  hasQuality: boolean
}

function statsFor(day: DayPlan, today: number): DayStats {
  const runs = [
    ...day.sessions.map((m) => m.activity).filter((a) => a !== null),
    ...day.extras,
  ].filter((a) => isRun(a.sportType))

  const plannedM = day.sessions
    .filter((m) => SESSION_META[m.session.type].countsAsVolume)
    .reduce((sum, m) => sum + (m.session.targetDistanceM ?? 0), 0)

  return {
    date: day.date,
    actualM: runs.reduce((sum, a) => sum + a.distanceM, 0),
    plannedM,
    isToday: day.date === today,
    hasQuality: day.sessions.some((m) => isQuality(m.session.type)),
  }
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
    <div className={cn('flex items-end gap-1 rounded-2xl bg-surface-deep/25 px-2 py-1.5', className)}>
      {days.map((d, i) => (
        <DayColumn key={d.date} stats={d} weekday={WEEKDAYS[i]!} peak={peak} />
      ))}
    </div>
  )
}

function DayColumn({ stats, weekday, peak }: { stats: DayStats; weekday: string; peak: number }) {
  const actualPct = Math.round((stats.actualM / peak) * 100)
  const plannedPct = Math.round((stats.plannedM / peak) * 100)
  const dayOfMonth = new Date(stats.date).getUTCDate()

  return (
    <div className="flex flex-1 flex-col items-center gap-1 px-0.5 py-1.5">
      <span
        className={cn(
          'text-caption2 font-medium uppercase',
          stats.isToday ? 'text-mint' : 'text-label-3',
        )}
      >
        {weekday}
      </span>

      <span className="relative flex w-full justify-center" style={{ height: TRACK }}>
        {/* Prescribed volume: a ghost the actual bar grows into. */}
        {plannedPct > 0 ? (
          <span
            className="absolute bottom-0 w-full rounded-lg border border-dashed border-line-strong"
            style={{ height: `${Math.max(plannedPct, 2)}%` }}
          />
        ) : null}

        {stats.actualM > 0 ? (
          <span
            className={cn(
              'absolute bottom-0 w-full rounded-lg',
              stats.hasQuality ? 'bg-amber' : 'bg-label-2',
            )}
            style={{ height: `${Math.max(actualPct, 3)}%` }}
          />
        ) : null}

        {/* Target line, drawn over the bar — otherwise an overshoot hides the ghost
            outline entirely and the day reads as merely "done" rather than "over". */}
        {plannedPct > 0 ? (
          <span
            className={cn(
              'absolute w-full border-t',
              stats.actualM > stats.plannedM ? 'border-surface-deep/80' : 'border-label-3',
            )}
            style={{ bottom: `${Math.max(plannedPct, 2)}%` }}
          />
        ) : null}

        {/* A rest day reads as deliberate, not as missing data. */}
        {stats.actualM === 0 && plannedPct === 0 ? (
          <span className="absolute bottom-0 h-px w-3 bg-fill-strong" />
        ) : null}
      </span>

      <span
        className={cn(
          'data-number text-caption2',
          stats.actualM > 0 ? 'text-label' : 'text-label-4',
        )}
      >
        {stats.actualM > 0 ? formatKm(stats.actualM) : '–'}
      </span>

      <span
        className={cn(
          'flex size-5 items-center justify-center rounded-full text-caption2 tabular-nums',
          stats.isToday ? 'bg-mint font-semibold text-surface' : 'text-label-4',
        )}
      >
        {dayOfMonth}
      </span>
    </div>
  )
}
