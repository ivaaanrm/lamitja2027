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
import { BarRow, LineChart, StackedBar } from './charts'
import { useBlock } from './useBlock'
import { Card, CardTitle, Chip, Delta, Stat, ZONE_ACCENT } from './ui'

/**
 * Cómo va la temporada, medida contra la anterior.
 *
 * Every comparison on this page is aligned on race day rather than on week 1: last
 * season's build was 20 weeks and this one is 23, so "week 12" is not the same place in
 * the two, and "eleven weeks out" always is. `baseline.ts` does the shifting; from here
 * last season is simply another list of activities.
 *
 * The order is deliberate — form now, then the plan, then last season. The question this
 * page opens on is "what shape am I in today", and the comparison is the answer's context,
 * not the other way round.
 */
export function Progress() {
  const { data, now, error, progress, currentWeek } = useBlock()

  const view = useMemo(() => (data ? build(data.activities, now) : null), [data, now])

  if (error && !data) {
    return (
      <Card>
        <p className="text-sm text-red-400">{error}</p>
      </Card>
    )
  }
  if (!data || !view || !progress) {
    return (
      <Card>
        <p className="text-sm text-neutral-500">Cargando…</p>
      </Card>
    )
  }

  return (
    <>
      <SeasonHero view={view} currentWeek={currentWeek} />
      <FormCard view={view} />
      <WeeklyCard view={view} progress={progress} currentWeek={currentWeek} />
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
    cumulative: cumulativeByDay(activities, BLOCK_START, RACE_DATE).map((v, i) =>
      i > todayIndex ? null : v,
    ),
    lastCumulative: cumulativeByDay(BASELINE, BLOCK_START, RACE_DATE),
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

// ---------------------------------------------------------------------------

function SeasonHero({ view, currentWeek }: { view: View; currentWeek: number }) {
  const km = view.season.totals.distanceM / 1000
  const lastKm = view.last.totals.distanceM / 1000

  return (
    <Card>
      <div className="flex items-baseline justify-between gap-3">
        <p className="text-xs font-medium uppercase tracking-widest text-neutral-500">
          Semana {currentWeek + 1} de {TOTAL_WEEKS}
        </p>
        <p className="text-xs text-neutral-500">faltan {daysToRace(view.today)} días</p>
      </div>

      <p className="mt-2 text-4xl font-semibold tabular-nums">
        {decimal(km, 0)}
        <span className="ml-1.5 text-base font-normal text-neutral-500">km en el bloque</span>
      </p>

      <p className="mt-1 text-sm text-neutral-400">
        {view.tooEarly ? (
          <>
            La temporada pasada aún no había empezado a correr — su bloque abre en la semana{' '}
            {BASELINE_FIRST_WEEK + 1}.
          </>
        ) : (
          <>
            <Delta value={percentDelta(km, lastKm)} className="text-sm" /> respecto a la temporada
            pasada en el mismo punto ({decimal(lastKm, 0)} km).
          </>
        )}
      </p>

      <figure className="mt-5">
        <LineChart
          label="Kilómetros acumulados en el bloque frente a la temporada pasada"
          steps={view.axis.length}
          height={96}
          markers={[{ at: view.todayIndex }]}
          shadeFrom={view.todayIndex}
          series={[
            { values: view.lastCumulative, className: 'stroke-neutral-600', dashed: true },
            {
              values: view.cumulative,
              className: 'stroke-neutral-100',
              areaClassName: 'fill-neutral-100/[0.07]',
            },
          ]}
        />
        <figcaption className="mt-2 flex items-center justify-between gap-2 text-[0.625rem] text-neutral-600">
          <span>17 ago</span>
          <Legend
            items={[
              { label: 'Este bloque', className: 'bg-neutral-100' },
              { label: '2025-26', className: 'bg-neutral-600' },
            ]}
          />
          <span>24 ene</span>
        </figcaption>
      </figure>
    </Card>
  )
}

function FormCard({ view }: { view: View }) {
  const latest = view.fitness.at(-1)
  const form = latest?.form ?? 0
  const { label, tone } = formLabel(form)
  const lastAtToday = view.lastFitnessLine[view.todayIndex] ?? null

  return (
    <Card>
      <CardTitle
        action={
          <Chip tone={tone === 'good' ? 'done' : tone === 'warn' ? 'down' : 'neutral'}>{label}</Chip>
        }
      >
        Forma y frescura
      </CardTitle>

      <dl className="grid grid-cols-3 gap-y-4">
        <Stat
          label="Forma"
          value={Math.round(latest?.fitness ?? 0)}
          hint={
            lastAtToday == null ? 'carga a 42 días' : `${Math.round(lastAtToday)} la pasada`
          }
        />
        <Stat label="Fatiga" value={Math.round(latest?.fatigue ?? 0)} hint="carga a 7 días" />
        <Stat label="Frescura" value={signed(form)} hint="forma − fatiga" />
      </dl>

      <figure className="mt-5">
        <LineChart
          label="Forma y fatiga a lo largo del bloque, frente a la forma de la temporada pasada"
          steps={view.axis.length}
          height={88}
          markers={[{ at: view.todayIndex }]}
          shadeFrom={view.todayIndex}
          series={[
            { values: view.lastFitnessLine, className: 'stroke-neutral-600', dashed: true },
            { values: view.fatigueLine, className: 'stroke-rose-400/70', strokeWidth: 1.5 },
            {
              values: view.fitnessLine,
              className: 'stroke-sky-400',
              areaClassName: 'fill-sky-400/10',
            },
          ]}
        />
        <figcaption className="mt-2 text-[0.625rem] leading-relaxed text-neutral-600">
          <Legend
            items={[
              { label: 'Forma', className: 'bg-sky-400' },
              { label: 'Fatiga', className: 'bg-rose-400/70' },
              { label: '2025-26', className: 'bg-neutral-600' },
            ]}
          />
          <p className="mt-1.5">
            La carga es el esfuerzo relativo de Strava
            {view.season.estimated > 0.05
              ? `, estimado en el ${Math.round(view.season.estimated * 100)}% de este bloque — esas salidas fueron sin pulsómetro`
              : ''}
            . La curva de 2025-26 arranca en cero porque el histórico empieza con su bloque.
          </p>
        </figcaption>
      </figure>
    </Card>
  )
}

function WeeklyCard({
  view,
  progress,
  currentWeek,
}: {
  view: View
  progress: NonNullable<ReturnType<typeof useBlock>['progress']>
  currentWeek: number
}) {
  const bars = view.weekly.map((week, i) => ({
    key: i,
    value: (week?.distanceM ?? 0) / 1000,
    ghost: view.lastWeekly[i] == null ? null : view.lastWeekly[i]!.distanceM / 1000,
    target: (progress.weekly[i]?.targetVolumeM ?? 0) / 1000,
    className:
      i === currentWeek ? 'bg-neutral-100' : i < currentWeek ? 'bg-neutral-400' : 'bg-neutral-700/60',
    title: `S${i + 1}: ${decimal((week?.distanceM ?? 0) / 1000)} km`,
  }))

  const peak = Math.max(0, ...view.weekly.map((w) => w?.distanceM ?? 0))
  const lastPeak = Math.max(0, ...view.lastWeekly.map((w) => w?.distanceM ?? 0))

  return (
    <Card>
      <CardTitle>Volumen semanal</CardTitle>
      <BarRow bars={bars} height={80} />
      <div className="mt-2 flex items-center justify-between gap-2 text-[0.625rem] tabular-nums text-neutral-600">
        <span>S1</span>
        <Legend
          items={[
            { label: 'Corrido', className: 'bg-neutral-300' },
            { label: '2025-26', className: 'bg-neutral-100/25' },
            { label: 'Objetivo', className: 'bg-neutral-600' },
          ]}
        />
        <span>S{TOTAL_WEEKS}</span>
      </div>

      <dl className="mt-5 grid grid-cols-3 gap-y-4">
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
          hint={lastPeak ? `${decimal(lastPeak / 1000, 0)} km la pasada` : 'km'}
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
      </dl>
    </Card>
  )
}

function ProjectionCard({ view }: { view: View }) {
  const projection = view.projection
  const goalDelta = projection ? projection.timeS - GOAL_TIME_S : null

  return (
    <Card>
      <CardTitle>Proyección</CardTitle>

      {projection && goalDelta != null ? (
        <>
          <p className="text-3xl font-semibold tabular-nums">
            {formatClock(projection.timeS)}
            <span className="ml-2 text-sm font-normal text-neutral-500">media proyectada</span>
          </p>
          <p className="mt-1 text-sm">
            <span className={cn(goalDelta <= 0 ? 'text-emerald-400' : 'text-amber-400')}>
              {goalDelta <= 0
                ? `${formatClock(Math.abs(goalDelta))} por dentro del objetivo`
                : `a ${formatClock(goalDelta)} de ${formatClock(GOAL_TIME_S)}`}
            </span>
            <span className="text-neutral-500"> · desde tu {projection.from.label}</span>
          </p>
        </>
      ) : (
        <p className="text-sm text-neutral-500">
          Todavía no hay nada lo bastante largo desde lo que proyectar — el listón más corto son
          5 km.
        </p>
      )}

      <div className="mt-5 flex items-baseline justify-between gap-3 pb-1 text-[0.625rem] uppercase tracking-widest text-neutral-600">
        <span>Distancia</span>
        <span className="flex gap-3">
          <span>Este bloque</span>
          <span className="w-24 text-right">2025-26</span>
        </span>
      </div>

      <ul className="divide-y divide-neutral-800 border-t border-neutral-800">
        {view.efforts.map((effort, i) => {
          const last = view.lastEfforts[i]
          return (
            <li key={effort.label} className="flex items-baseline justify-between gap-3 py-2.5">
              <span className="text-sm text-neutral-300">{effort.label}</span>
              <span className="flex items-baseline gap-3 text-right">
                <span className="text-sm tabular-nums">
                  {effort.timeS == null ? (
                    <span className="text-neutral-600">—</span>
                  ) : (
                    formatClock(effort.timeS)
                  )}
                </span>
                <span className="w-24 text-xs tabular-nums text-neutral-500">
                  {last?.timeS == null ? '' : formatClock(last.timeS)}
                </span>
              </span>
            </li>
          )
        })}
      </ul>

      <p className="mt-3 text-[0.6875rem] leading-relaxed text-neutral-600">
        El mejor ritmo medio en una salida completa de al menos esa distancia, llevada al listón
        exacto — la app guarda resúmenes, no los parciales de los que Strava saca sus mejores
        marcas. Solo cuentan los esfuerzos: Z4 o más, o más rápido que ritmo medio. La media se
        proyecta con Riegel. El objetivo es {formatClock(GOAL_TIME_S)} a{' '}
        {formatPace(GOAL_PACE_S_KM)}/km.
      </p>
    </Card>
  )
}

function IntensityCard({ view }: { view: View }) {
  const total = view.zones.reduce((sum, z) => sum + z.movingS, 0)

  return (
    <Card>
      <CardTitle>Reparto por zonas</CardTitle>

      {total === 0 ? (
        <p className="text-sm text-neutral-500">
          Aún no hay ninguna salida con pulso. Las zonas se leen del pulsómetro, no se deducen del
          ritmo.
        </p>
      ) : (
        <>
          <StackedBar
            parts={view.zones
              .filter((z) => z.movingS > 0)
              .map((z) => ({ key: z.zone, value: z.movingS, className: ZONE_ACCENT[z.zone].bar }))}
          />
          <ul className="mt-4 space-y-2">
            {view.zones
              .filter((z) => z.movingS > 0)
              .reverse()
              .map((zone) => (
                <li key={zone.zone} className="flex items-baseline justify-between gap-3">
                  <span className="flex items-center gap-2">
                    <span className={cn('size-2 rounded-full', ZONE_ACCENT[zone.zone].bar)} />
                    <span className="text-sm text-neutral-300">{ZONE_NAME[zone.zone]}</span>
                  </span>
                  <span className="shrink-0 text-xs tabular-nums text-neutral-500">
                    {formatDuration(zone.movingS)} · {Math.round((zone.movingS / total) * 100)}%
                  </span>
                </li>
              ))}
          </ul>
          {view.zoneCoverage < 0.95 ? (
            <p className="mt-3 text-[0.6875rem] text-neutral-600">
              El {Math.round((1 - view.zoneCoverage) * 100)}% del tiempo corriendo fue sin pulso y
              no cuenta aquí.
            </p>
          ) : null}
        </>
      )}
    </Card>
  )
}

function ConsistencyCard({ view }: { view: View }) {
  const now = view.season.consistency
  const then = view.last.consistency

  return (
    <Card>
      <CardTitle>Constancia</CardTitle>

      <dl className="grid grid-cols-3 gap-y-4">
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
      </dl>

      <p className="mt-4 text-[0.6875rem] leading-relaxed text-neutral-600">
        Corriste {now.daysRun} de {now.days} días. El entrenamiento cruzado no cierra un parón de
        carrera: una semana de bici alrededor de una rodilla tocada es una buena semana y sigue
        siendo una semana sin correr.
      </p>
    </Card>
  )
}

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
      label: 'Kilómetros',
      now: view.season.totals.distanceM / 1000,
      then: view.last.totals.distanceM / 1000,
      format: (v) => decimal(v, 0),
    },
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
      label: 'Más larga',
      now: view.season.totals.longestM / 1000,
      then: view.last.totals.longestM / 1000,
      format: (v) => `${decimal(v)} km`,
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
    <Card>
      <CardTitle
        action={
          <span className="text-[0.625rem] uppercase tracking-widest text-neutral-600">
            vs 2025-26
          </span>
        }
      >
        Cara a cara
      </CardTitle>

      <table className="w-full text-sm">
        <tbody className="divide-y divide-neutral-800">
          {rows.map((row) => (
            <tr key={row.label}>
              <td className="py-2.5 pr-2 text-neutral-400">{row.label}</td>
              <td className="py-2.5 text-right tabular-nums">{row.format(row.now)}</td>
              <td className="w-24 py-2.5 pl-3 text-right tabular-nums text-neutral-500">
                {row.then === 0 ? '—' : row.format(row.then)}
              </td>
              <td className="w-14 py-2.5 pl-2 text-right">
                <Delta value={percentDelta(row.now, row.then)} better={row.better ?? 'up'} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <p className="mt-3 text-[0.6875rem] leading-relaxed text-neutral-600">
        Las dos temporadas medidas a la misma distancia del día de carrera: hoy faltan{' '}
        {daysToRace(view.today)} días, que la temporada pasada fue el{' '}
        {dateFmt.format(new Date(view.today - BASELINE_SHIFT_MS))}.
      </p>
    </Card>
  )
}

function Legend({ items }: { items: { label: string; className: string }[] }) {
  return (
    <span className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1">
      {items.map((item) => (
        <span key={item.label} className="flex items-center gap-1.5">
          <span className={cn('h-[3px] w-3 rounded-full', item.className)} />
          {item.label}
        </span>
      ))}
    </span>
  )
}
