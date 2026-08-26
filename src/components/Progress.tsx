import { useMemo } from 'react'
import { formatClock, formatDuration, formatKm, formatPace } from '@/lib/activity'
import {
  BLOCK_START,
  DAY_MS,
  GOAL_TIME_S,
  RACE_DATE,
  TOTAL_WEEKS,
  daysToRace,
  startOfDay,
} from '@/lib/block'
import { BASELINE, BASELINE_FIRST_WEEK, BASELINE_SHIFT_MS, PRE_BLOCK } from '@/lib/baseline'
import {
  bestEfforts,
  cumulativeByDay,
  days,
  fitnessSeries,
  formLabel,
  percentDelta,
  projectHalf,
  summarise,
  weeklyTotals,
  zoneCoverage,
  zoneShares,
} from '@/lib/analytics'
import { cn } from '@/lib/cn'
import type { Activity } from '@/lib/db/schema'
import { decimal } from '@/lib/format'
import { GOAL_PACE_S_KM } from '@/lib/metrics'
import { ZONE_NAME } from '@/lib/paces'
import { BarRow, ChartLegend, ChartScale, LineChart, Sparkline, StackedBar } from './charts'
import { useBlock } from './useBlock'
import { island } from './Island'
import {
  Card,
  CardTitle,
  Chip,
  Delta,
  EmptyState,
  ErrorCard,
  HeroMetric,
  LoadingCard,
  Skeleton,
  Stat,
  StatStrip,
  ZONE_ACCENT,
} from './ui'

/**
 * Cómo va la temporada, medida contra la anterior.
 *
 * Every comparison on this page is aligned on race day rather than on week 1: last
 * season's build was 20 weeks and this one is 23, so "week 12" is not the same place in
 * the two, and "eleven weeks out" always is. `baseline.ts` does the shifting; from here
 * last season is simply another list of activities. Block weeks 1–3 have no counterpart
 * at all, and everything here draws that as absence rather than as a zero.
 *
 * This is a *reading* screen — Hoy is where a decision gets made — so the tempo is one
 * dashboard card at the top and then a descent into denser and denser evidence. The
 * order is the order of the questions: what have I actually run, what shape is it putting
 * me in, what does that project to, how did I get there, and finally the whole ledger
 * side by side.
 *
 * Six cards, down from seven, and the merge that got it there was a demotion. The screen
 * used to open on a hero card whose only other content was a full-width cumulative km
 * line against last season — two curves that can only ever go up, whose single reading is
 * the gap between them, which is the number the hero already prints — and then repeat the
 * whole volume question as a second card underneath. The chart is now a sparkline in the
 * hero's trailing slot, at the size that reading is worth, and the volume card it used to
 * push down is the same card: hero, weekly bars, stat strip.
 */
function ProgressScreen() {
  const { data, now, error, reload, progress, currentWeek } = useBlock()

  const view = useMemo(() => (data ? build(data.activities, now) : null), [data, now])

  if (error && !data)
    return <ErrorCard title="Sin datos del bloque" message={error} onRetry={() => void reload()} />
  if (!data || !view || !progress) return <Loading />

  return (
    <>
      <VolumeCard view={view} progress={progress} currentWeek={currentWeek} />
      <FormCard view={view} />
      <ProjectionCard view={view} />
      <IntensityCard view={view} />
      <ConsistencyCard view={view} />
      <HeadToHead view={view} />
    </>
  )
}

// ---------------------------------------------------------------------------
// Everything the page shows, derived once
// ---------------------------------------------------------------------------

type View = ReturnType<typeof build>

function build(activities: Activity[], now: number) {
  const today = startOfDay(now)
  // The block's whole calendar is the x-axis, so the future is visible as space still to
  // fill rather than as a chart that stops where the data does.
  const axis = days(BLOCK_START, RACE_DATE)
  const todayIndex = Math.max(
    0,
    Math.min(axis.length - 1, Math.round((today - BLOCK_START) / DAY_MS)),
  )

  const season = summarise(activities, BLOCK_START, today, PRE_BLOCK)
  const last = summarise(BASELINE, BLOCK_START, today)

  const fitness = fitnessSeries([...PRE_BLOCK, ...activities], BLOCK_START, today)
  const lastFitness = fitnessSeries(BASELINE, BLOCK_START, RACE_DATE)

  const efforts = bestEfforts(activities)
  const lastEfforts = bestEfforts(BASELINE)

  return {
    today,
    axis,
    todayIndex,
    season,
    last,
    /** True until the block reaches the week last season's build opened in. */
    tooEarly: last.totals.runs === 0,
    /**
     * No previous season at all — a fork that put no CSVs in `docs/data/`. Distinct from
     * `tooEarly`, which is a season that exists and has not opened yet: with nothing to
     * compare against there is no week to name, and every line that names one is
     * describing a build nobody ever ran.
     */
    noBaseline: BASELINE.length === 0,
    fitness,
    // Padded to the full axis: this season stops at today, last season runs to the race.
    fitnessLine: pad(
      fitness.map((p) => p.fitness),
      axis.length,
    ),
    fatigueLine: pad(
      fitness.map((p) => p.fatigue),
      axis.length,
    ),
    lastFitnessLine: lastFitness.map((p) => (p.fitness === 0 ? null : p.fitness)),
    // Only as far as today, so the sparkline spends its whole width on the days that
    // have happened rather than compressing them into the left eighth of the block.
    cumulative: cumulativeByDay(activities, BLOCK_START, today),
    weekly: weeklyTotals(activities, TOTAL_WEEKS),
    lastWeekly: weeklyTotals(BASELINE, TOTAL_WEEKS),
    efforts,
    lastEfforts,
    projection: projectHalf(efforts),
    zones: zoneShares(activities),
    zoneCoverage: zoneCoverage(activities),
  }
}

/** Extends a series to the axis with nulls — a gap, not a run of zeroes. */
const pad = (values: number[], length: number): (number | null)[] => [
  ...values,
  ...Array.from({ length: Math.max(0, length - values.length) }, () => null),
]

/** `+8`, `−12`, `0` — signed off the rounded value, so 0,4 does not print as `+0`. */
function signed(value: number): string {
  const rounded = Math.round(value)
  return rounded > 0 ? `+${rounded}` : String(rounded)
}

const dateFmt = new Intl.DateTimeFormat('es-ES', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  // Dates are UTC midnight of the local day; formatting in the viewer's zone slides them.
  timeZone: 'UTC',
})

/** `17 ago` — the ends of an axis, where the year is already the block's. */
const dayFmt = new Intl.DateTimeFormat('es-ES', {
  day: 'numeric',
  month: 'short',
  timeZone: 'UTC',
})

/**
 * The screen's shape while `/api/data` is in flight.
 *
 * Not `LoadingCard` for the first card: that primitive draws a title, a hero block and
 * rows, and this screen opens on a hero *beside a ring* over a bar chart over a stat
 * strip. A skeleton whose shape is wrong is worse than none, because the card visibly
 * rearranges itself the moment the payload lands. The two trend cards below it really are
 * title-plus-numbers-plus-chart, so those take the primitive as it comes — with `busy` off,
 * because one `/api/data` request is one wait and the card that leads it is the one that
 * announces it, not all three.
 *
 * No `fade-up` on any of them either: the skeleton already breathes, and the real cards fade
 * up as they replace it. Two reveals over the same pixels inside half a second is a flicker.
 */
function Loading() {
  return (
    <>
      <Card aria-busy="true" aria-label="Cargando el progreso">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0 flex-1">
            <Skeleton className="h-2.5 w-36" />
            <Skeleton className="mt-2 h-8 w-28" />
            <Skeleton className="mt-2.5 h-3 w-full" />
          </div>
          <Skeleton className="h-7 w-24" />
        </div>
        <Skeleton className="mt-3 h-20 w-full" />
        <div className="mt-3 grid grid-cols-3 gap-2.5">
          <Skeleton className="h-9" />
          <Skeleton className="h-9" />
          <Skeleton className="h-9" />
        </div>
      </Card>
      <LoadingCard rows={4} busy={false} />
      <LoadingCard rows={3} busy={false} />
    </>
  )
}

// ---------------------------------------------------------------------------

/**
 * What has actually been run, and against what.
 *
 * One card carries the whole volume question because it is one question asked at two
 * scales: the block total to date, traced beside it as the shape that total was reached
 * in, and then week by week with last season behind every bar and the plan's target
 * across it.
 *
 * The trace is the trailing slot rather than a ring on purpose. `/plan` already opens on
 * a hero with a ring beside it, and a third screen doing the same thing at the top is
 * three screens with one composition; more to the point, a cumulative line is the one
 * series on this page that nothing else draws, and its flat stretches are exactly the
 * breaks the constancia card counts further down. It is 88px because that is the size
 * that reading deserves — the full-width chart it replaced spent a quarter of the first
 * screen on two lines that can only ever go up.
 *
 * "Out of what" for the block total is answered by the bars, not by a percentage: 23
 * target rules say where the plan wanted each week to land, which is a far more useful
 * answer than one aggregate share of a number the athlete never thinks in.
 */
function VolumeCard({
  view,
  progress,
  currentWeek,
}: {
  view: View
  progress: NonNullable<ReturnType<typeof useBlock>['progress']>
  currentWeek: number
}) {
  const km = view.season.totals.distanceM / 1000
  const lastKm = view.last.totals.distanceM / 1000

  const bars = view.weekly.map((week, i) => {
    const value = (week?.distanceM ?? 0) / 1000
    const target = (progress.weekly[i]?.targetVolumeM ?? 0) / 1000
    return {
      key: i,
      value,
      ghost: view.lastWeekly[i] == null ? null : view.lastWeekly[i]!.distanceM / 1000,
      target,
      // Mint is state: the week being run now. Behind it is history, ahead of it is room.
      className: i === currentWeek ? 'bg-mint' : i < currentWeek ? 'bg-label-2' : 'bg-fill',
      title:
        target > 0
          ? `S${i + 1}: ${decimal(value)} de ${decimal(target, 0)} km`
          : `S${i + 1}: ${decimal(value)} km`,
    }
  })

  const compared = view.lastWeekly.some((w) => w != null && w.distanceM > 0)
  const peak = Math.max(0, ...view.weekly.map((w) => w?.distanceM ?? 0))
  const lastPeak = Math.max(0, ...view.lastWeekly.map((w) => w?.distanceM ?? 0))

  return (
    <Card className="fade-up">
      <HeroMetric
        eyebrow={`Semana ${currentWeek + 1} de ${TOTAL_WEEKS}`}
        value={decimal(km, 0)}
        unit="km en el bloque"
        context={
          view.noBaseline ? (
            <>Faltan {daysToRace(view.today)} días</>
          ) : (
            <>
              {view.tooEarly ? (
                <>
                  La temporada pasada aún no había empezado a correr, su bloque abre en la semana{' '}
                  {BASELINE_FIRST_WEEK + 1}
                </>
              ) : (
                <>
                  <Delta value={percentDelta(km, lastKm)} className="text-footnote" /> frente a los{' '}
                  {decimal(lastKm, 0)} km de la temporada pasada en este mismo punto
                </>
              )}
              <span className="text-label-3"> · faltan {daysToRace(view.today)} días</span>
            </>
          )
        }
        trailing={
          <Sparkline
            values={view.cumulative}
            width={88}
            height={34}
            areaClassName="fill-mint/10"
            label="Kilómetros acumulados en el bloque, día a día"
          />
        }
      />

      <figure className="mt-3">
        {/* The label says what the row is, in the same words the caption under it uses —
            the per-bar `title` is a desktop bonus, and a phone has no hover to reach it. */}
        <BarRow
          bars={bars}
          height={80}
          label={`Kilómetros por semana, de la semana 1 a la ${TOTAL_WEEKS}, con el objetivo de cada una cruzado sobre su barra${
            compared ? ' y la temporada 2025-26 en sombra detrás' : ''
          }. Van ${decimal(km, 0)} km en el bloque.`}
        />
        {/* The two things the bars encode that a bar cannot say on its own. The week
            colours are not in here: which bar is "now" is read off its position on a
            left-to-right week axis, not off the mint. */}
        <ChartScale start="S1" end={`S${TOTAL_WEEKS}`}>
          {compared ? 'sombra = 2025-26 · discontinua = objetivo' : 'discontinua = objetivo'}
        </ChartScale>
      </figure>

      <StatStrip className="mt-3">
        <Stat
          label="Por semana"
          value={decimal(view.season.distancePerWeekM / 1000, 0)}
          hint={
            view.tooEarly
              ? 'km por semana'
              : `${decimal(view.last.distancePerWeekM / 1000, 0)} km la pasada`
          }
        />
        <Stat
          label="Semana pico"
          value={peak ? decimal(peak / 1000, 0) : '—'}
          hint={lastPeak ? `${decimal(lastPeak / 1000, 0)} km la pasada` : 'km en una semana'}
        />
        <Stat
          label="Más larga"
          value={view.season.totals.longestM ? formatKm(view.season.totals.longestM) : '—'}
          hint={
            view.last.totals.longestM
              ? `${formatKm(view.last.totals.longestM)} km la pasada`
              : 'de 21,1 km'
          }
        />
      </StatStrip>
    </Card>
  )
}

/**
 * The 42/7-day pair, and what the difference between them says about today.
 *
 * `baseline` is on because this plot's floor is a real zero — no training is no load —
 * which is what lets a falling curve read as *falling* rather than as merely low. The
 * dashed 2025-26 line is named in the note rather than in the legend: three keys plus
 * both ends of the axis do not fit on one 375px caption row, and the note is where the
 * reason that line opens low belongs anyway.
 */
function FormCard({ view }: { view: View }) {
  const latest = view.fitness.at(-1)
  const form = latest?.form ?? 0
  const { label, tone } = formLabel(form)
  const lastAtToday = view.lastFitnessLine[view.todayIndex] ?? null

  return (
    <Card className="fade-up">
      <CardTitle
        action={
          <Chip tone={tone === 'good' ? 'done' : tone === 'warn' ? 'down' : 'neutral'}>{label}</Chip>
        }
      >
        Forma y frescura
      </CardTitle>

      <StatStrip>
        <Stat
          label="Forma"
          value={Math.round(latest?.fitness ?? 0)}
          hint={lastAtToday == null ? 'carga a 42 días' : `${Math.round(lastAtToday)} la pasada`}
        />
        <Stat label="Fatiga" value={Math.round(latest?.fatigue ?? 0)} hint="carga a 7 días" />
        <Stat label="Frescura" value={signed(form)} hint="forma − fatiga" />
      </StatStrip>

      <figure className="mt-3">
        <LineChart
          label="Forma y fatiga a lo largo del bloque, frente a la forma de la temporada pasada"
          steps={view.axis.length}
          height={88}
          baseline
          markers={[{ at: view.todayIndex, label: 'Hoy' }]}
          shadeFrom={view.todayIndex}
          series={[
            { values: view.lastFitnessLine, className: 'stroke-line-strong', dashed: true },
            { values: view.fatigueLine, className: 'stroke-coral', strokeWidth: 1.5 },
            {
              values: view.fitnessLine,
              className: 'stroke-mint',
              areaClassName: 'fill-mint/10',
            },
          ]}
        />
        <ChartScale
          start={dayFmt.format(new Date(BLOCK_START))}
          end={dayFmt.format(new Date(RACE_DATE))}
        >
          <ChartLegend
            dense
            items={[
              { label: 'Forma', className: 'bg-mint' },
              { label: 'Fatiga', className: 'bg-coral' },
            ]}
          />
        </ChartScale>
      </figure>

      <p className="mt-2.5 text-caption2 leading-relaxed text-label-3">
        La carga es el esfuerzo relativo de Strava
        {view.season.estimated > 0.05
          ? `, estimado en el ${Math.round(view.season.estimated * 100)}% de este bloque — esas salidas fueron sin pulsómetro`
          : ''}
        . A trazos, la forma de 2025-26: su histórico arranca con el bloque, así que abre
        desde abajo.
      </p>
    </Card>
  )
}

/**
 * What the running so far says the race would be, and the four bars it is read off.
 *
 * The delta column is the point of the table rather than a decoration on it: a 10K three
 * percent faster than last season's is the single most direct answer this screen has to
 * "am I ahead". `better="down"` because a race time that shrinks is the good one.
 *
 * Rows that came from a real activity link to its trace. The benchmark that is currently
 * the ceiling is the run most worth reopening, and `/actividad` is already the screen for
 * it — the last-season column never links, because those rows are CSV, not Strava.
 *
 * The one place this table does *not* follow the page's same-distance-from-race-day rule
 * is that column: `bestEfforts(BASELINE)` reads the whole of last season, not last season
 * up to this point, because a personal best is the record to beat rather than a snapshot.
 * That is only safe while it is said out loud, which is what the last clause of the note
 * under the table is for — a green arrow against an unstated baseline is a claim, not a
 * number.
 */
function ProjectionCard({ view }: { view: View }) {
  const projection = view.projection
  const goalDelta = projection ? projection.timeS - GOAL_TIME_S : null
  const anyEffort =
    view.efforts.some((e) => e.timeS != null) || view.lastEfforts.some((e) => e.timeS != null)
  const anyLink = view.efforts.some((e) => e.activity != null)
  const row = 'flex min-h-11 items-center gap-2'

  return (
    <Card className="fade-up">
      <CardTitle
        action={
          <span className="text-caption tabular-nums text-label-3">
            Objetivo {formatClock(GOAL_TIME_S)} · {formatPace(GOAL_PACE_S_KM)}/km
          </span>
        }
      >
        Proyección
      </CardTitle>

      {projection && goalDelta != null ? (
        <>
          <p className="data-number font-display text-title1 font-bold leading-none">
            {formatClock(projection.timeS)}
            <span className="ml-1.5 font-sans text-footnote font-normal tracking-normal text-label-3">
              media proyectada
            </span>
          </p>
          <p className="mt-2 text-footnote leading-relaxed">
            <span className={cn(goalDelta <= 0 ? 'text-mint' : 'text-amber')}>
              {goalDelta <= 0
                ? `${formatClock(Math.abs(goalDelta))} por dentro del objetivo`
                : `a ${formatClock(goalDelta)} del objetivo`}
            </span>
            <span className="text-label-3"> · desde tu {projection.from.label}</span>
          </p>
        </>
      ) : (
        <EmptyState>
          Aún no hay ningún esfuerzo de 5 km o más desde el que proyectar. Un rodaje no cuenta:
          hace falta Z4 o más, o correr por debajo de tu ritmo medio.
        </EmptyState>
      )}

      {anyEffort ? (
        <>
          <div
            className={cn(
              row,
              // `label-3`, not `label-4`: these name the three columns under them, which
              // makes them data, and `label-4` is the one step that misses AA.
              'mt-3 min-h-0 border-b border-line pb-1.5 text-caption2 uppercase tracking-wider text-label-3',
            )}
          >
            <span className="flex-1">Listón</span>
            <span className="w-16 text-right">Bloque</span>
            <span className="w-16 text-right">2025-26</span>
            <span className="w-12" />
          </div>

          <ul className="divide-y divide-line">
            {view.efforts.map((effort, i) => {
              const last = view.lastEfforts[i]
              const delta =
                effort.timeS == null || last?.timeS == null
                  ? null
                  : percentDelta(effort.timeS, last.timeS)
              const cells = (
                <>
                  <span className="flex-1 truncate text-footnote text-label-2">{effort.label}</span>
                  <span className="data-number w-16 text-right text-footnote">
                    {effort.timeS == null ? (
                      <span className="text-label-3">—</span>
                    ) : (
                      formatClock(effort.timeS)
                    )}
                  </span>
                  <span className="data-number w-16 text-right text-caption text-label-3">
                    {last?.timeS == null ? '' : formatClock(last.timeS)}
                  </span>
                  <span className="w-12 text-right">
                    <Delta value={delta} better="down" />
                  </span>
                </>
              )
              return (
                <li key={effort.label}>
                  {effort.activity ? (
                    <a href={`/actividad?id=${effort.activity.id}`} className={cn(row, 'tappable')}>
                      {cells}
                    </a>
                  ) : (
                    <div className={row}>{cells}</div>
                  )}
                </li>
              )
            })}
          </ul>
        </>
      ) : null}

      <p className="mt-2.5 text-caption2 leading-relaxed text-label-3">
        Cada listón es el ritmo medio de una salida completa de al menos esa distancia, llevado a
        la distancia exacta — la app guarda resúmenes, no parciales — y solo cuentan los
        esfuerzos: Z4 o más, o más rápido que ritmo medio. La columna de 2025-26 es la mejor marca
        de toda aquella temporada. La media se proyecta con Riegel.
        {anyLink ? ' Toca un listón para abrir esa salida.' : ''}
      </p>
    </Card>
  )
}

/**
 * Where the time actually went, which is the check on the plan's second promise: that
 * frequency goes up and intensity does not.
 *
 * The bar is drawn whether or not there is anything in it — an empty track plus the
 * sentence that says why is the shape of the answer, and it stops the card collapsing to
 * a title for the weeks before the strap records anything.
 */
function IntensityCard({ view }: { view: View }) {
  const present = view.zones.filter((z) => z.movingS > 0)
  const total = present.reduce((sum, z) => sum + z.movingS, 0)

  return (
    <Card className="fade-up">
      <CardTitle>Reparto por zonas</CardTitle>

      <StackedBar
        parts={present.map((z) => ({
          key: z.zone,
          value: z.movingS,
          className: ZONE_ACCENT[z.zone].bar,
        }))}
        // The list under the bar reads out every zone with its time and its share, so the
        // bar says what it is and points at the list rather than repeating five numbers.
        label="Reparto del tiempo por zonas de intensidad. El detalle, zona a zona, está en la lista siguiente."
        emptyLabel="Aún no hay ninguna salida con pulso: las zonas se leen del pulsómetro, nunca del ritmo."
      />

      {total > 0 ? (
        <ul className="mt-2.5 space-y-2">
          {[...present].reverse().map((zone) => (
            <li key={zone.zone} className="flex items-baseline justify-between gap-2">
              <span className="flex items-center gap-1.5">
                <span className={cn('size-2 shrink-0 rounded-full', ZONE_ACCENT[zone.zone].bar)} />
                <span className="text-footnote text-label-2">{ZONE_NAME[zone.zone]}</span>
              </span>
              <span className="shrink-0 text-caption tabular-nums text-label-3">
                {formatDuration(zone.movingS)} · {Math.round((zone.movingS / total) * 100)}%
              </span>
            </li>
          ))}
        </ul>
      ) : null}

      <p className="mt-2.5 text-caption2 leading-relaxed text-label-3">
        La comprobación del plan: que suba la frecuencia y no la intensidad.
        {view.zoneCoverage > 0 && view.zoneCoverage < 0.95
          ? ` El ${Math.round((1 - view.zoneCoverage) * 100)}% del tiempo corriendo fue sin pulso y no cuenta aquí.`
          : ''}
      </p>
    </Card>
  )
}

/** The other thing that broke last season: not the totals, the gaps. */
function ConsistencyCard({ view }: { view: View }) {
  const now = view.season.consistency
  const then = view.last.consistency

  return (
    <Card className="fade-up">
      <CardTitle>Constancia</CardTitle>

      <StatStrip>
        <Stat
          label="Salidas/sem"
          value={decimal(now.runsPerWeek)}
          hint={view.tooEarly ? 'objetivo 5–6' : `${decimal(then.runsPerWeek)} la pasada`}
        />
        <Stat
          label="Parón mayor"
          value={now.longestGapDays}
          hint={view.tooEarly ? 'días sin correr' : `${then.longestGapDays} la pasada`}
        />
        <Stat
          label="Parones 6d+"
          value={now.breaks}
          hint={view.tooEarly ? 'el patrón a romper' : `${then.breaks} la pasada`}
        />
      </StatStrip>

      <p className="mt-2.5 text-caption2 leading-relaxed text-label-3">
        Corriste {now.daysRun} de {now.days} días. El entrenamiento cruzado no cierra un parón de
        carrera: una semana de bici alrededor de una rodilla tocada es una buena semana y sigue
        siendo una semana sin correr.
      </p>
    </Card>
  )
}

/**
 * The ledger, and deliberately only the half of it that is not already on the screen.
 *
 * Kilometres, the longest run and the peak week all live in the first card with last
 * season in their hints, so repeating them here would be the same comparison drawn twice
 * — which is how a comparison stops being read at all. What is left is what nothing else
 * on the page says.
 *
 * Nothing renders at all until the baseline reaches the block: for weeks 1–3 there is no
 * counterpart to compare against, and the hero has already said so in a sentence. A card
 * repeating it would be a second explanation of the same absence.
 */
function HeadToHead({ view }: { view: View }) {
  if (view.tooEarly) return null

  const rows: {
    label: string
    now: number
    then: number
    format: (v: number) => string
    better?: 'up' | 'down'
  }[] = [
    {
      label: 'Salidas',
      now: view.season.totals.runs,
      then: view.last.totals.runs,
      format: (v) => String(Math.round(v)),
    },
    {
      label: 'Tiempo en pie',
      now: view.season.totals.movingS,
      then: view.last.totals.movingS,
      format: formatDuration,
    },
    {
      label: 'Desnivel',
      now: view.season.totals.elevationM,
      then: view.last.totals.elevationM,
      format: (v) => `${decimal(v, 0)} m`,
    },
    {
      label: 'Ritmo medio',
      now: view.season.totals.meanPaceSKm ?? 0,
      then: view.last.totals.meanPaceSKm ?? 0,
      format: (v) => `${formatPace(v)}/km`,
      // Faster is lower, so a shrinking number is the good one.
      better: 'down',
    },
    {
      label: 'Días parado',
      now: view.season.consistency.days - view.season.consistency.daysRun,
      then: view.last.consistency.days - view.last.consistency.daysRun,
      format: (v) => String(Math.round(v)),
      better: 'down',
    },
  ]

  return (
    <Card className="fade-up">
      <CardTitle
        action={
          // `label-3`: this names what the third column of the table is measured against,
          // which makes it data rather than chrome.
          <span className="text-caption2 uppercase tracking-wider text-label-3">vs 2025-26</span>
        }
      >
        Cara a cara
      </CardTitle>

      <table className="w-full text-footnote">
        <tbody className="divide-y divide-line">
          {rows.map((row) => (
            <tr key={row.label}>
              <td className="py-2.5 pr-2 text-label-2">{row.label}</td>
              <td className="data-number py-2.5 text-right">{row.format(row.now)}</td>
              <td className="data-number w-20 py-2.5 pl-3 text-right text-label-3">
                {row.then === 0 ? '—' : row.format(row.then)}
              </td>
              <td className="w-12 py-2.5 pl-2 text-right">
                <Delta value={percentDelta(row.now, row.then)} better={row.better ?? 'up'} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <p className="mt-2.5 text-caption2 leading-relaxed text-label-3">
        Las dos temporadas medidas a la misma distancia del día de carrera: hoy faltan{' '}
        {daysToRace(view.today)} días, que la temporada pasada fue el{' '}
        {dateFmt.format(new Date(view.today - BASELINE_SHIFT_MS))}.
      </p>
    </Card>
  )
}

/**
 * The screen as the page mounts it: wrapped so a render that throws leaves a card with a
 * way out on it rather than an empty column under the heading. See `Island.tsx`.
 */
export const Progress = island(ProgressScreen)
