import { useState } from 'react'
import { formatKm, formatPace, isRun, paceSKm } from '@/lib/activity'
import { cn } from '@/lib/cn'
import { SESSION_META, type DayPlan, type WeekPlan } from '@/lib/plan'

/**
 * The week at a glance: seven days, each a bar of kilometres run against a ghost bar of
 * what was prescribed.
 *
 * Hand-rolled rather than a charting library. Seven bars is not enough data to justify
 * ~100 KB of Recharts, and this is a calendar first — weekday headers, a today marker and
 * tappable day cells are things a chart component would fight rather than help with.
 * The real charts (volume trend, pace trend over the block) are where a library earns its
 * weight.
 */

const WEEKDAYS = ['M', 'T', 'W', 'T', 'F', 'S', 'S']

/** Bar track height in px. Fixed so the row keeps its shape on an empty week. */
const TRACK = 88

interface DayStats {
  day: DayPlan
  date: number
  actualM: number
  plannedM: number
  isToday: boolean
  isFuture: boolean
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
    day,
    date: day.date,
    actualM: runs.reduce((sum, a) => sum + a.distanceM, 0),
    plannedM,
    isToday: day.date === today,
    isFuture: day.date > today,
    hasQuality: day.sessions.some((m) =>
      ['tempo', 'interval', 'race'].includes(m.session.type),
    ),
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
  const [selected, setSelected] = useState<number | null>(null)

  const days = week.days.map((day) => statsFor(day, today))
  // Scale to the tallest thing in the week — planned or actual — so a big long run does
  // not flatten every other bar, and an overshoot still reads as an overshoot.
  const peak = Math.max(1000, ...days.map((d) => Math.max(d.actualM, d.plannedM)))

  const open = selected === null ? null : days.find((d) => d.date === selected) ?? null

  return (
    <div className={className}>
      <div className="flex items-end gap-1.5">
        {days.map((d, i) => (
          <DayColumn
            key={d.date}
            stats={d}
            weekday={WEEKDAYS[i]!}
            peak={peak}
            selected={selected === d.date}
            onSelect={() => setSelected(selected === d.date ? null : d.date)}
          />
        ))}
      </div>

      {open ? <DayDetail stats={open} /> : null}
    </div>
  )
}

function DayColumn({
  stats,
  weekday,
  peak,
  selected,
  onSelect,
}: {
  stats: DayStats
  weekday: string
  peak: number
  selected: boolean
  onSelect: () => void
}) {
  const actualPct = Math.round((stats.actualM / peak) * 100)
  const plannedPct = Math.round((stats.plannedM / peak) * 100)
  const dayOfMonth = new Date(stats.date).getUTCDate()

  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={cn(
        'flex flex-1 flex-col items-center gap-1.5 rounded-xl px-0.5 py-2 transition-colors',
        selected ? 'bg-neutral-800/70' : 'active:bg-neutral-800/40',
      )}
    >
      <span
        className={cn(
          'text-[10px] font-medium uppercase',
          stats.isToday ? 'text-white' : 'text-neutral-500',
        )}
      >
        {weekday}
      </span>

      <span className="relative flex w-full justify-center" style={{ height: TRACK }}>
        {/* Prescribed volume: a ghost the actual bar grows into. */}
        {plannedPct > 0 ? (
          <span
            className="absolute bottom-0 w-full rounded-md border border-dashed border-neutral-700"
            style={{ height: `${Math.max(plannedPct, 2)}%` }}
          />
        ) : null}

        {stats.actualM > 0 ? (
          <span
            className={cn(
              'absolute bottom-0 w-full rounded-md',
              stats.hasQuality ? 'bg-amber-400' : 'bg-white',
            )}
            style={{ height: `${Math.max(actualPct, 3)}%` }}
          />
        ) : null}

        {/* A rest day reads as deliberate, not as missing data. */}
        {stats.actualM === 0 && plannedPct === 0 ? (
          <span className="absolute bottom-0 h-px w-3 bg-neutral-700" />
        ) : null}
      </span>

      <span
        className={cn(
          'text-[11px] tabular-nums',
          stats.actualM > 0 ? 'text-neutral-200' : 'text-neutral-600',
        )}
      >
        {stats.actualM > 0 ? formatKm(stats.actualM) : '–'}
      </span>

      <span
        className={cn(
          'flex size-5 items-center justify-center rounded-full text-[10px] tabular-nums',
          stats.isToday ? 'bg-white font-semibold text-neutral-950' : 'text-neutral-600',
        )}
      >
        {dayOfMonth}
      </span>
    </button>
  )
}

const dayFmt = new Intl.DateTimeFormat('en-GB', {
  weekday: 'long',
  day: 'numeric',
  month: 'short',
  // Dates are UTC midnight of the local day; formatting in the viewer's zone slides them.
  timeZone: 'UTC',
})

function DayDetail({ stats }: { stats: DayStats }) {
  const { day } = stats
  const runs = [
    ...day.sessions.map((m) => m.activity).filter((a) => a !== null),
    ...day.extras,
  ]

  return (
    <div className="mt-3 space-y-2 rounded-xl bg-neutral-900 p-3">
      <p className="text-xs font-medium text-neutral-400">{dayFmt.format(new Date(day.date))}</p>

      {day.sessions.length === 0 && runs.length === 0 ? (
        <p className="text-xs text-neutral-500">Rest day.</p>
      ) : null}

      {day.sessions.map((match) => (
        <div key={match.session.id} className="flex items-baseline justify-between gap-3">
          <p className={cn('truncate text-sm', match.done ? 'text-neutral-500 line-through' : '')}>
            {match.session.title}
          </p>
          <p className="shrink-0 text-xs tabular-nums text-neutral-500">
            {match.session.targetDistanceM ? `${formatKm(match.session.targetDistanceM)} km` : '—'}
          </p>
        </div>
      ))}

      {runs.map((run) => (
        <div key={run.id} className="flex items-baseline justify-between gap-3">
          <p className="truncate text-xs text-neutral-400">{run.name}</p>
          <p className="shrink-0 text-xs tabular-nums text-neutral-400">
            {formatKm(run.distanceM)} km
            {isRun(run.sportType)
              ? ` · ${formatPace(paceSKm(run.distanceM, run.movingS))}/km`
              : ''}
          </p>
        </div>
      ))}
    </div>
  )
}

