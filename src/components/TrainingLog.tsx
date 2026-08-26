import { useMemo, useState } from 'react'
import { formatDuration, formatKm, formatPace, isRun, paceSKm } from '@/lib/activity'
import { BLOCK_START, DAY_MS, startOfDay, startOfWeek } from '@/lib/block'
import { BASELINE } from '@/lib/baseline'
import { percentDelta, summarise, weeklyTotals } from '@/lib/analytics'
import { cn } from '@/lib/cn'
import type { Activity } from '@/lib/db/schema'
import { decimal } from '@/lib/format'
import { SESSION_META, weekDays, type SessionType, type WeekPlan } from '@/lib/plan'
import { ChartLegend } from './charts'
import { useBlock } from './useBlock'
import { island } from './Island'
import {
  ACCENT,
  Button,
  CHEVRON_RIGHT,
  Card,
  CardTitle,
  Delta,
  EmptyState,
  ErrorCard,
  HeroMetric,
  Icon,
  Segmented,
  Skeleton,
  Stat,
  StatStrip,
  TextLink,
} from './ui'

/**
 * El registro: qué se ha hecho, semana a semana y salida a salida.
 *
 * Three tempos, in this order, and the order is the whole composition:
 *
 *   1. **One number.** Kilometres over the chosen window, against the same window of
 *      2025-26. It is the first thing on the screen because "how much have I run" is the
 *      question this tab is opened with, and the segmented control sits *under* it — the
 *      hero is the answer, the control is how you re-ask it.
 *   2. **A texture.** Seven dots a row, sized by distance and coloured by the session they
 *      answered, is a training block read as a shape: the rhythm of hard days, a down
 *      week, a gap where a week went missing, all visible before a single number is.
 *   3. **A list.** The one run you then want to look at, grouped by month and staggered in
 *      as it arrives. Rows, not cards — a hundred cards is a hundred boxes doing one box's
 *      work.
 *
 * That top-to-bottom gearing (one metric → one picture → many rows) is what keeps this tab
 * from resolving into the same stack of cards as `/` and `/progreso`.
 *
 * Only weeks that have started are drawn on the grid. This is the log, not the plan; an
 * empty row for December is the planner's job, and `/plan` already does it.
 */
function TrainingLogScreen() {
  const { data, now, error, reload, weeks, currentWeek } = useBlock()

  if (error && !data)
    return <ErrorCard title="Sin datos del bloque" message={error} onRetry={() => void reload()} />
  if (!data) return <LogSkeleton />

  return (
    <>
      <SummaryCard activities={data.activities} now={now} />
      <GridCard weeks={weeks} activities={data.activities} currentWeek={currentWeek} now={now} />
      <ActivityListCard activities={data.activities} weeks={weeks} />
    </>
  )
}

/**
 * The screen, in outline, while `/api/data` is in flight.
 *
 * Shaped rather than generic: the hero block, the control and the three stats are where
 * they will be, and the list is five rows of the real row height, so nothing jumps when
 * the payload lands. `LoadingCard` was the obvious reach and it is the wrong shape here —
 * it draws a title, a hero and three lines of prose, and this screen's first card has a
 * segmented control and a stat strip in it.
 *
 * No `fade-up` on these: the skeleton already breathes, and the real cards fade up as they
 * replace it. Two reveals over the same pixels inside half a second is a flicker, not a
 * transition.
 */
function LogSkeleton() {
  return (
    <>
      <Card aria-busy="true" aria-label="Cargando el registro">
        <Skeleton className="h-2.5 w-24" />
        <Skeleton className="mt-2 h-8 w-32" />
        <Skeleton className="mt-2.5 h-3 w-48" />
        <Skeleton className="mt-3 h-11 w-full rounded-xl" />
        <div className="mt-3 grid grid-cols-3 gap-2.5">
          {[0, 1, 2].map((i) => (
            <div key={i}>
              <Skeleton className="h-2.5 w-14" />
              <Skeleton className="mt-1.5 h-4 w-12" />
            </div>
          ))}
        </div>
      </Card>

      <Card aria-hidden>
        <Skeleton className="h-2.5 w-28" />
        <div className="mt-3 space-y-3">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-6 w-full" />
          ))}
        </div>
      </Card>

      <Card aria-hidden>
        <Skeleton className="h-2.5 w-20" />
        <Skeleton className="mt-2 h-11 w-full rounded-xl" />
        <div className="mt-2">
          {[0, 1, 2, 3, 4].map((i) => (
            <div key={i} className="flex min-h-16 items-center gap-2 border-t border-line py-2.5">
              <Skeleton className="h-8 w-[3px] rounded-full" />
              <div className="min-w-0 flex-1">
                <Skeleton className="h-3 w-2/3" />
                <Skeleton className="mt-1.5 h-2.5 w-1/3" />
              </div>
              <div className="w-[4.5rem]">
                <Skeleton className="ml-auto h-3 w-14" />
                <Skeleton className="mt-1.5 ml-auto h-2.5 w-10" />
              </div>
            </div>
          ))}
        </div>
      </Card>
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

/** The window said in full, above the number. The control below says it in three words. */
const RANGE_LABEL: Record<Range, string> = {
  week: 'Esta semana',
  month: 'Últimos 28 días',
  block: 'Bloque completo',
}

/** Where each range opens. All three end today, so the comparison window is the same. */
function rangeStart(range: Range, today: number): number {
  if (range === 'week') return Math.max(BLOCK_START, startOfWeek(today))
  if (range === 'month') return Math.max(BLOCK_START, today - 27 * DAY_MS)
  return BLOCK_START
}

/**
 * The screen's one hero: kilometres over the window, and what they were last season.
 *
 * This was a 2x2 grid of four equal numbers, which is four numbers and no answer. Distance
 * is the one the tab is about, so it is the hero; mean pace became the hint under `Tiempo`
 * rather than a column of its own, because a pace *is* time over distance and reads as
 * that number's context. Three columns is what is left, and three columns at 375px leave
 * every hint enough width to say what its number is measured against.
 */
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
  const ran = season.totals.runs > 0

  // One sentence, and it changes with what there is to say. A hero number with no context
  // line is trivia; "0,0 km" with no explanation is a bug wearing a number's clothes.
  const context = ran
    ? lastKm > 0
      ? `Frente a ${decimal(lastKm)} km en la misma ventana de 2025-26.`
      : 'En 2025-26 el bloque todavía no había empezado a estas alturas.'
    : lastKm > 0
      ? `Sin salidas todavía; la temporada pasada llevaba ${decimal(lastKm)} km.`
      : 'Todavía sin salidas en esta ventana.'

  return (
    <Card className="fade-up">
      <HeroMetric
        eyebrow={RANGE_LABEL[range]}
        value={decimal(km)}
        unit="km"
        context={context}
        // The delta and the sentence are one reading: the arrow-free sign says which way,
        // the sentence says against what. Lifted a step off `caption` so it holds its own
        // beside a 34px number without becoming a second focal point.
        trailing={
          lastKm > 0 ? <Delta value={percentDelta(km, lastKm)} className="text-subhead" /> : undefined
        }
      />

      <Segmented options={RANGES} value={range} onChange={setRange} className="mt-3" label="Ventana" />

      <StatStrip className="mt-3">
        <Stat
          label="Salidas"
          value={season.totals.runs}
          hint={`${season.consistency.daysRun} de ${season.consistency.days} días`}
        />
        <Stat
          label="Tiempo"
          value={formatDuration(season.totals.movingS)}
          hint={
            season.totals.meanPaceSKm
              ? `${formatPace(season.totals.meanPaceSKm)}/km de media`
              : 'en movimiento'
          }
        />
        <Stat label="Desnivel" value={`${decimal(season.totals.elevationM, 0)} m`} hint="de subida" />
      </StatStrip>
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
    <Card className="fade-up">
      <CardTitle
        action={
          <TextLink href="/plan" inset>
            Ver plan
          </TextLink>
        }
      >
        Semana a semana
      </CardTitle>

      {/* Same column structure as a row — spacer, seven cells, total — so the letters sit
          over the dots rather than drifting by the width of two gaps, and `km` names the
          column it heads instead of being explained in a paragraph underneath. */}
      <div className="flex items-center gap-1 text-caption2 text-label-3">
        <span className="w-6 shrink-0" />
        {WEEKDAYS.map((day, i) => (
          <span key={i} className="flex-1 text-center">
            {day}
          </span>
        ))}
        <span className="w-[3.25rem] shrink-0 pl-1 text-right">km</span>
      </div>

      <ol className="mt-1">
        {rows.map(({ week, cells }) => {
          const km = cells.reduce((sum, c) => sum + c.distanceM, 0) / 1000
          const lastKm = lastWeekly[week.weekIndex]
            ? lastWeekly[week.weekIndex]!.distanceM / 1000
            : null
          const isCurrent = week.weekIndex === currentWeek

          return (
            <li
              key={week.weekIndex}
              // The week being run is marked twice over: the mint wash, and its label in
              // mint at a heavier weight. Colour alone would leave the row unmarked for
              // anyone who cannot separate the two grounds.
              aria-current={isCurrent ? 'true' : undefined}
              className={cn(
                'flex items-center gap-1 border-t border-line py-1.5',
                isCurrent && 'bg-mint/[0.07]',
              )}
            >
              <span
                className={cn(
                  'data-number w-6 shrink-0 text-caption2',
                  // `label-3`, not `label-4`: a week number is data — it is how a row is
                  // named — and `label-4` is the one step that misses AA.
                  isCurrent ? 'font-semibold text-mint' : 'text-label-3',
                )}
              >
                S{week.weekIndex + 1}
              </span>

              {cells.map((cell) => (
                <Dot key={cell.date} cell={cell} peak={peak} />
              ))}

              <span className="w-[3.25rem] shrink-0 pl-1 text-right">
                <span
                  className={cn(
                    'data-number block text-caption',
                    km > 0 ? 'text-label' : 'text-label-4',
                  )}
                >
                  {km > 0 ? decimal(km) : '–'}
                </span>
                {/* Last season is data, not chrome, so it reads at `label-3` — the quiet
                    step that still clears AA — one size down rather than one shade too
                    faint to be read at all. */}
                {lastKm != null ? (
                  <span className="data-number block text-caption2 text-label-3">
                    {decimal(lastKm)}
                  </span>
                ) : null}
              </span>
            </li>
          )
        })}
      </ol>

      {/* Only the kinds actually on the grid, so the key never explains a colour that is
          not there. On an empty grid it explains nothing at all, and a key with no entries
          over a caption describing dots that are not there is the emptiest kind of empty
          state — so the whole footer becomes one sentence instead. */}
      {kinds.length > 0 || hasUnplanned ? (
        <>
          <ChartLegend
            className="mt-2"
            items={[
              ...kinds.map((type) => ({
                label: SESSION_META[type].label,
                className: ACCENT[type].rail,
                shape: 'dot' as const,
              })),
              ...(hasUnplanned
                ? [{ label: 'Sin planificar', className: 'bg-label-2', shape: 'dot' as const }]
                : []),
            ]}
          />

          <p className="mt-2 text-caption2 leading-relaxed text-label-3">
            El área de cada punto son sus kilómetros. Debajo del total, en gris, la misma
            semana de 2025-26 a la misma distancia del día de carrera.
          </p>
        </>
      ) : (
        <EmptyState className="mt-1">
          Aún no hay ningún día que dibujar. Cada salida aparecerá aquí como un punto del
          tamaño de sus kilómetros, con el color de la sesión que cumplió.
        </EmptyState>
      )}
    </Card>
  )
}

function Dot({ cell, peak }: { cell: DayCell; peak: number }) {
  // Area, not diameter: a 20 km day is twice the ink of a 10 km day, not four times it.
  const size = cell.distanceM > 0 ? Math.max(7, DOT_MAX * Math.sqrt(cell.distanceM / peak)) : 0

  return (
    <span
      // Today is marked on the cell rather than on the dot, so the mark survives a day
      // that was actually run — the old ring only ever showed on an empty square, which
      // is precisely the day you are least likely to be looking for.
      className={cn(
        'flex flex-1 items-center justify-center',
        cell.isToday && 'rounded-md bg-ink/[0.07]',
      )}
      style={{ height: DOT_MAX }}
      // The kilometres are drawn as area and nothing else, so the reading has to be in the
      // accessibility tree as well: `title` is a desktop bonus, and a phone has no hover to
      // put one behind. Days with nothing on them stay silent — seven "sin salida" a week
      // is noise, not information.
      role={cell.distanceM > 0 ? 'img' : undefined}
      aria-label={
        cell.distanceM > 0
          ? `${dayFmt.format(new Date(cell.date))}: ${decimal(cell.distanceM / 1000)} km${
              cell.type ? ` · ${SESSION_META[cell.type].label}` : ''
            }`
          : undefined
      }
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
          className={cn('rounded-full', cell.type ? ACCENT[cell.type].rail : 'bg-label-2')}
          style={{ width: size, height: size }}
        />
      ) : (
        // Hollow, not filled: an empty today is a day still to run, and a solid dot the
        // size of a short one would read as a run that already happened.
        <span
          className={cn('rounded-full', cell.isToday ? 'size-2 ring-1 ring-label-3' : 'size-1 bg-fill')}
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

/** Why the list is empty, per filter — the sentence, not the shrug. */
const EMPTY_COPY: Record<Filter, string> = {
  all: 'Todavía no hay ninguna actividad dentro del bloque. Strava se sincroniza cada noche y cada salida aparece aquí en cuanto lo hace.',
  run: 'Todavía no hay ninguna carrera dentro del bloque.',
  other: 'Nada fuera de correr todavía: la fuerza, la bici y el cruzado aparecen en esta vista.',
}

const monthFmt = new Intl.DateTimeFormat('es-ES', {
  month: 'long',
  year: 'numeric',
  timeZone: 'UTC',
})
// The month is the group heading, so the row only has to say which day of it this was.
const dayFmt = new Intl.DateTimeFormat('es-ES', {
  weekday: 'short',
  day: 'numeric',
  timeZone: 'UTC',
})

interface MonthGroup {
  label: string
  items: Activity[]
  distanceM: number
}

function ActivityListCard({ activities, weeks }: { activities: Activity[]; weeks: WeekPlan[] }) {
  const [filter, setFilter] = useState<Filter>('all')

  /**
   * Which prescribed session each activity answered — the plan, read backwards.
   *
   * The type is all a row needs: it names the session ("Series") and picks the rail's
   * hue, while the activity's own Strava name is already the row's title.
   */
  const answered = useMemo(() => {
    const map = new Map<number, SessionType>()
    for (const week of weeks) {
      for (const match of week.sessions) {
        if (match.activity) map.set(match.activity.id, match.session.type)
      }
    }
    return map
  }, [weeks])

  // Grouped as the list walks backwards through the calendar, so a month heading is a
  // real heading over a real list rather than a paragraph smuggled into the first row.
  const groups = useMemo(() => {
    const shown = activities
      .filter((a) =>
        filter === 'all' ? true : filter === 'run' ? isRun(a.sportType) : !isRun(a.sportType),
      )
      .sort((a, b) => b.startedOn - a.startedOn)

    const out: MonthGroup[] = []
    for (const activity of shown) {
      const label = monthFmt.format(new Date(activity.startedOn))
      const open = out.at(-1)
      if (open && open.label === label) {
        open.items.push(activity)
        open.distanceM += activity.distanceM
      } else {
        out.push({ label, items: [activity], distanceM: activity.distanceM })
      }
    }
    return out
  }, [activities, filter])

  const count = groups.reduce((sum, group) => sum + group.items.length, 0)

  // The stagger counts rows, not groups, so the reveal cascades down the screen once
  // rather than restarting at every month. Capped at the eighth: a ninth row waiting a
  // third of a second to exist is a loading screen, not a reveal.
  let revealed = 0

  return (
    <Card>
      <CardTitle
        action={
          count > 0 ? (
            <span className="data-number text-caption2 text-label-3">{count}</span>
          ) : undefined
        }
      >
        Actividades
      </CardTitle>
      <Segmented options={FILTERS} value={filter} onChange={setFilter} label="Tipo de actividad" />

      {count === 0 ? (
        <EmptyState
          className="mt-3"
          action={
            filter === 'all' ? undefined : <Button onClick={() => setFilter('all')}>Ver todo</Button>
          }
        >
          {EMPTY_COPY[filter]}
        </EmptyState>
      ) : (
        groups.map((group) => (
          <div key={group.label} className="mt-3 first:mt-2">
            <div className="flex items-baseline justify-between gap-2 px-0.5">
              <h3 className="text-caption2 font-medium uppercase tracking-[0.12em] text-label-3">
                {group.label}
              </h3>
              {/* Only when it means something: a month of strength work totals 0 km, and
                  a zero there would read as a month that went unrun. */}
              {group.distanceM > 0 ? (
                <span className="data-number text-caption2 text-label-3">
                  {formatKm(group.distanceM)} km
                </span>
              ) : null}
            </div>
            <ul>
              {group.items.map((activity) => {
                const delay = Math.min(revealed++, 7) * 30
                return (
                  <li
                    key={activity.id}
                    className="fade-up"
                    style={{ animationDelay: `${delay}ms` }}
                  >
                    <ActivityRow activity={activity} answered={answered.get(activity.id) ?? null} />
                  </li>
                )
              })}
            </ul>
          </div>
        ))
      )}
    </Card>
  )
}

/**
 * One row of the log, and the entry point to `/actividad`.
 *
 * A row, emphatically not a card: at a hundred and fifty activities a card apiece is a
 * hundred and fifty boxes doing one box's work. The rhythm comes from a hairline and a
 * 64px floor instead, which is also comfortably past the 44px a thumb needs.
 *
 * The right-hand numbers sit in a fixed-width column so they line up down the whole list —
 * the difference between a list you scan and a list you read. Which number leads depends
 * on what the activity actually measured: a strength session has no distance, and `0,0 km`
 * is a number that says nothing.
 */
function ActivityRow({
  activity,
  answered,
}: {
  activity: Activity
  /** The type of the prescribed session this answered, if it answered one. */
  answered: SessionType | null
}) {
  const run = isRun(activity.sportType)
  const measured = activity.distanceM > 0
  const primary = measured ? `${formatKm(activity.distanceM)} km` : formatDuration(activity.movingS)
  const secondary = !measured
    ? null
    : run
      ? `${formatPace(paceSKm(activity.distanceM, activity.movingS))}/km`
      : formatDuration(activity.movingS)

  return (
    <a
      href={`/actividad?id=${activity.id}`}
      className="tappable flex min-h-16 items-center gap-2 border-t border-line py-2.5"
    >
      <span
        aria-hidden
        className={cn(
          'h-8 w-[3px] shrink-0 rounded-full',
          answered ? ACCENT[answered].rail : 'bg-fill-strong',
        )}
      />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-footnote text-label">{activity.name}</span>
        {/* The rail's colour is repeated as a word here, so the session type is never
            carried by the hue alone. */}
        <span className="block truncate text-caption text-label-3">
          {dayFmt.format(new Date(activity.startedOn))}
          {answered ? ` · ${SESSION_META[answered].label}` : ''}
        </span>
      </span>
      <span className="w-[4.5rem] shrink-0 text-right">
        <span className="data-number block text-footnote font-semibold text-label">{primary}</span>
        {secondary ? (
          <span className="data-number block text-caption text-label-3">{secondary}</span>
        ) : null}
      </span>
      <Icon path={CHEVRON_RIGHT} className="text-label-4" />
    </a>
  )
}

/**
 * The screen as the page mounts it: wrapped so a render that throws leaves a card with a
 * way out on it rather than an empty column under the heading. See `Island.tsx`.
 */
export const TrainingLog = island(TrainingLogScreen)
