import { useMemo, useState } from 'react'
import { formatDuration, formatKm, formatPace, isRun, paceSKm } from '@/lib/activity'
import { BLOCK_START, DAY_MS, startOfDay, startOfWeek } from '@/lib/block'
import { BASELINE } from '@/lib/baseline'
import { activityLoad, percentDelta, summarise, weeklyTotals } from '@/lib/analytics'
import { cn } from '@/lib/cn'
import type { Activity } from '@/lib/db/schema'
import { decimal } from '@/lib/format'
import { ZONE_NAME, hrZone } from '@/lib/paces'
import { SESSION_META, weekDays, type SessionType, type WeekPlan } from '@/lib/plan'
import { useBlock } from './useBlock'
import { ACCENT, Card, CardTitle, Chip, Delta, Segmented, Stat, ZONE_ACCENT } from './ui'

/**
 * El registro: qué se ha hecho, semana a semana y salida a salida.
 *
 * The grid is the page's centre of gravity. Seven dots a row, sized by distance and
 * coloured by the session they answered, is a training block read as a texture — the
 * rhythm of hard days, the shape of a down week and a gap where a week went missing are
 * all visible before a single number is. The list underneath is for the one run you then
 * want to look at.
 *
 * Only weeks that have started are drawn. This is the log, not the plan; an empty row for
 * December is the planner's job, and `/plan` already does it.
 */
export function TrainingLog() {
  const { data, now, error, weeks, currentWeek } = useBlock()

  if (error && !data) {
    return (
      <Card>
        <p className="text-sm text-red">{error}</p>
      </Card>
    )
  }
  if (!data) {
    return (
      <Card>
        <p className="text-sm text-label-3">Cargando…</p>
      </Card>
    )
  }

  return (
    <>
      <SummaryCard activities={data.activities} now={now} />
      <GridCard weeks={weeks} activities={data.activities} currentWeek={currentWeek} now={now} />
      <ActivityListCard activities={data.activities} weeks={weeks} />
    </>
  )
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

type Range = 'week' | 'month' | 'block'

const RANGES: { value: Range; label: string }[] = [
  { value: 'week', label: 'Semana' },
  { value: 'month', label: '28 días' },
  { value: 'block', label: 'Bloque' },
]

/** Where each range opens. All three end today, so the comparison window is the same. */
function rangeStart(range: Range, today: number): number {
  if (range === 'week') return Math.max(BLOCK_START, startOfWeek(today))
  if (range === 'month') return Math.max(BLOCK_START, today - 27 * DAY_MS)
  return BLOCK_START
}

function SummaryCard({ activities, now }: { activities: Activity[]; now: number }) {
  const [range, setRange] = useState<Range>('week')
  const today = startOfDay(now)

  const { season, last } = useMemo(() => {
    const from = rangeStart(range, today)
    return {
      season: summarise(activities, from, today),
      // The baseline already sits on this block's calendar, so the same dates cut the
      // same stretch out of last season.
      last: summarise(BASELINE, from, today),
    }
  }, [activities, range, today])

  const km = season.totals.distanceM / 1000
  const lastKm = last.totals.distanceM / 1000

  return (
    <Card>
      <Segmented options={RANGES} value={range} onChange={setRange} />

      <dl className="mt-5 grid grid-cols-2 gap-y-5">
        <Stat
          label="Kilómetros"
          value={decimal(km)}
          hint={lastKm > 0 ? `${decimal(lastKm)} la temporada pasada` : 'sin referencia'}
        />
        <Stat
          label="Salidas"
          value={season.totals.runs}
          hint={`${season.consistency.daysRun} de ${season.consistency.days} días`}
        />
        <Stat label="Tiempo" value={formatDuration(season.totals.movingS)} hint="en movimiento" />
        <Stat
          label="Desnivel"
          value={`${decimal(season.totals.elevationM, 0)} m`}
          hint={
            season.totals.meanPaceSKm ? `${formatPace(season.totals.meanPaceSKm)}/km de media` : '—'
          }
        />
      </dl>

      {lastKm > 0 ? (
        <p className="mt-5 flex items-center gap-2 text-xs text-label-3">
          <Delta value={percentDelta(km, lastKm)} />
          <span>frente a la temporada pasada en la misma ventana.</span>
        </p>
      ) : null}
    </Card>
  )
}

// ---------------------------------------------------------------------------
// The grid
// ---------------------------------------------------------------------------

const WEEKDAYS = ['L', 'M', 'X', 'J', 'V', 'S', 'D']
/** Diameter of the fullest day, px. Everything else is scaled by area, not by width. */
const DOT_MAX = 26

interface DayCell {
  date: number
  distanceM: number
  type: SessionType | null
  isToday: boolean
}

function cellsFor(week: WeekPlan, today: number): DayCell[] {
  return weekDays(week.weekIndex).map((date) => {
    const day = week.days.find((d) => d.date === date)
    const runs = [
      ...(day?.sessions.map((m) => m.activity).filter((a) => a !== null) ?? []),
      ...(day?.extras ?? []),
    ].filter((a) => isRun(a.sportType))

    // Coloured by the session it answered, so the log reads against the plan rather than
    // as an undifferentiated pile of kilometres. A quality day wins a double.
    const done = day?.sessions.filter((m) => m.activity) ?? []
    const quality = done.find((m) => SESSION_META[m.session.type].isQuality)
    const type = quality?.session.type ?? done[0]?.session.type ?? null

    return {
      date,
      distanceM: runs.reduce((sum, a) => sum + a.distanceM, 0),
      type: runs.length > 0 ? type : null,
      isToday: date === today,
    }
  })
}

function GridCard({
  weeks,
  activities,
  currentWeek,
  now,
}: {
  weeks: WeekPlan[]
  activities: Activity[]
  currentWeek: number
  now: number
}) {
  const today = startOfDay(now)
  const lastWeekly = useMemo(() => weeklyTotals(BASELINE, weeks.length), [weeks.length])

  // Newest first: the page opens on the week being run, not on August.
  const rows = weeks
    .slice(0, currentWeek + 1)
    .reverse()
    .map((week) => ({ week, cells: cellsFor(week, today) }))
  const peak = Math.max(1, ...activities.filter((a) => isRun(a.sportType)).map((a) => a.distanceM))
  const drawn = new Set(rows.flatMap((r) => r.cells.filter((c) => c.distanceM > 0).map((c) => c.type)))
  const kinds = [...drawn].filter((type) => type !== null)
  // A run that answered no session is drawn too, in neutral — the key has to say so, or
  // the one colour on the grid without a name is the one that needs explaining most.
  const hasUnplanned = drawn.has(null)

  return (
    <Card>
      <CardTitle
        action={
          <a href="/plan" className="-my-2 inline-flex min-h-11 items-center px-2 text-xs text-label-2 underline underline-offset-4">
            Ver plan
          </a>
        }
      >
        Semana a semana
      </CardTitle>

      {/* Same column structure as a row — spacer, seven cells, spacer — so the letters sit
          over the dots rather than drifting by the width of two gaps. */}
      <div className="flex items-center gap-1 text-caption2 text-label-4">
        <span className="w-6 shrink-0" />
        {WEEKDAYS.map((day, i) => (
          <span key={i} className="flex-1 text-center">
            {day}
          </span>
        ))}
        <span className="w-[3.25rem] shrink-0" />
      </div>

      <ol className="mt-1">
        {rows.map(({ week, cells }) => {
          const km = cells.reduce((sum, c) => sum + c.distanceM, 0) / 1000
          const lastKm = lastWeekly[week.weekIndex]
            ? lastWeekly[week.weekIndex]!.distanceM / 1000
            : null

          return (
            <li
              key={week.weekIndex}
              className={cn(
                'flex items-center gap-1 border-t border-line py-1.5',
                week.weekIndex === currentWeek && 'bg-mint/[0.07]',
              )}
            >
              <span className="data-number w-6 shrink-0 text-caption2 text-label-4">
                S{week.weekIndex + 1}
              </span>

              {cells.map((cell) => (
                <Dot key={cell.date} cell={cell} peak={peak} />
              ))}

              <span className="w-[3.25rem] shrink-0 pl-1 text-right">
                <span
                  className={cn(
                    'data-number block text-xs',
                    km > 0 ? 'text-label' : 'text-label-4',
                  )}
                >
                  {km > 0 ? decimal(km) : '–'}
                </span>
                {lastKm != null ? (
                  <span className="data-number block text-caption2 text-label-4">
                    {decimal(lastKm)}
                  </span>
                ) : null}
              </span>
            </li>
          )
        })}
      </ol>

      {/* Only the kinds actually on the grid, so the key never explains a colour that is
          not there — and shrinks to nothing in the first week of a block. */}
      <div className="mt-3 flex flex-wrap gap-x-3 gap-y-1 text-caption2 text-label-3">
        {kinds.map((type) => (
          <span key={type} className="flex items-center gap-1.5">
            <span className={cn('size-2 rounded-full', ACCENT[type].rail)} />
            {SESSION_META[type].label}
          </span>
        ))}
        {hasUnplanned ? (
          <span className="flex items-center gap-1.5">
            <span className="size-2 rounded-full bg-label-2" />
            Sin planificar
          </span>
        ) : null}
      </div>

      <p className="mt-3 text-caption2 leading-relaxed text-label-3">
        Cada punto es un día, con el área proporcional a los kilómetros y el color de la sesión
        que cumplió. El número gris de la derecha es la misma semana de 2025-26, a la misma
        distancia del día de carrera.
      </p>
    </Card>
  )
}

function Dot({ cell, peak }: { cell: DayCell; peak: number }) {
  // Area, not diameter: a 20 km day is twice the ink of a 10 km day, not four times it.
  const size = cell.distanceM > 0 ? Math.max(7, DOT_MAX * Math.sqrt(cell.distanceM / peak)) : 0

  return (
    <span
      className="flex flex-1 items-center justify-center"
      style={{ height: DOT_MAX }}
      title={
        cell.distanceM > 0
          ? `${decimal(cell.distanceM / 1000)} km`
          : cell.isToday
            ? 'hoy'
            : undefined
      }
    >
      {size > 0 ? (
        <span
          className={cn(
            'rounded-full',
            cell.type ? ACCENT[cell.type].rail : 'bg-label-2',
          )}
          style={{ width: size, height: size }}
        />
      ) : (
        <span
          className={cn(
            'rounded-full',
            cell.isToday ? 'size-2 ring-1 ring-label-3' : 'size-1 bg-fill',
          )}
        />
      )}
    </span>
  )
}

// ---------------------------------------------------------------------------
// The list
// ---------------------------------------------------------------------------

type Filter = 'all' | 'run' | 'other'

const FILTERS: { value: Filter; label: string }[] = [
  { value: 'all', label: 'Todo' },
  { value: 'run', label: 'Carrera' },
  { value: 'other', label: 'Otros' },
]

const monthFmt = new Intl.DateTimeFormat('es-ES', { month: 'long', year: 'numeric', timeZone: 'UTC' })
const dayFmt = new Intl.DateTimeFormat('es-ES', {
  weekday: 'short',
  day: 'numeric',
  month: 'short',
  timeZone: 'UTC',
})

function ActivityListCard({ activities, weeks }: { activities: Activity[]; weeks: WeekPlan[] }) {
  const [filter, setFilter] = useState<Filter>('all')

  /** Which prescribed session each activity answered — the plan, read backwards. */
  const answered = useMemo(() => {
    const map = new Map<number, { title: string; type: SessionType }>()
    for (const week of weeks) {
      for (const match of week.sessions) {
        if (match.activity) {
          map.set(match.activity.id, { title: match.session.title, type: match.session.type })
        }
      }
    }
    return map
  }, [weeks])

  const shown = useMemo(
    () =>
      activities
        .filter((a) =>
          filter === 'all' ? true : filter === 'run' ? isRun(a.sportType) : !isRun(a.sportType),
        )
        .sort((a, b) => b.startedOn - a.startedOn),
    [activities, filter],
  )

  // One heading per month, emitted as the list walks backwards through it.
  let month: string | null = null

  return (
    <Card>
      <CardTitle>Actividades</CardTitle>
      <Segmented options={FILTERS} value={filter} onChange={setFilter} />

      {shown.length === 0 ? (
        <p className="mt-5 text-sm text-label-3">Nada todavía en esta vista.</p>
      ) : (
        <ul className="mt-2">
          {shown.map((activity) => {
            const heading = monthFmt.format(new Date(activity.startedOn))
            const isNewMonth = heading !== month
            month = heading

            return (
              <li key={activity.id}>
                {isNewMonth ? (
                  <p className="mt-4 mb-1 text-caption2 font-medium uppercase tracking-widest text-label-3 first:mt-0">
                    {heading}
                  </p>
                ) : null}
                <ActivityRow activity={activity} answered={answered.get(activity.id) ?? null} />
              </li>
            )
          })}
        </ul>
      )}
    </Card>
  )
}

function ActivityRow({
  activity,
  answered,
}: {
  activity: Activity
  answered: { title: string; type: SessionType } | null
}) {
  const run = isRun(activity.sportType)

  return (
    <a
      href={`/actividad?id=${activity.id}`}
      className="flex min-h-16 items-center gap-3 border-t border-line py-2.5 transition-opacity active:opacity-60"
    >
      <span
        aria-hidden
        className={cn(
          'h-8 w-[3px] shrink-0 rounded-full',
          answered ? ACCENT[answered.type].rail : 'bg-fill',
        )}
      />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm">{activity.name}</span>
        <span className="block text-xs text-label-3">
          {dayFmt.format(new Date(activity.startedOn))}
          {answered ? ` · ${SESSION_META[answered.type].label}` : ''}
        </span>
      </span>
      <span className="shrink-0 text-right">
        <span className="data-number block text-sm">{formatKm(activity.distanceM)} km</span>
        <span className="data-number block text-xs text-label-3">
          {run ? `${formatPace(paceSKm(activity.distanceM, activity.movingS))}/km` : formatDuration(activity.movingS)}
        </span>
      </span>
      <svg
        aria-hidden
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="size-4 shrink-0 text-label-4"
      >
        <path d="m9 6 6 6-6 6" />
      </svg>
    </a>
  )
}
