import { useMemo, useState } from 'react'
import { formatClock, formatDuration, formatKm, formatPace } from '@/lib/activity'
import { DAY_MS, daysToRace, goalPaceSKm, startOfDay, totalWeeks, type BlockConfig } from '@/lib/block'
import { baselineFor, type Baseline } from '@/lib/baseline'
import {
  bestEfforts,
  cumulativeByDay,
  days,
  fitnessSeries,
  formLabel,
  goalEquivalent,
  percentDelta,
  projectEffort,
  projectHalf,
  summarise,
  weeklyTotals,
  zoneCoverage,
  zoneShares,
} from '@/lib/analytics'
import { cn } from '@/lib/cn'
import type { Activity } from '@/lib/db/schema'
import { decimal } from '@/lib/format'
import { DEFAULT_HR_MAX, ZONE_NAME, zoneFloorsBpm, type Zone } from '@/lib/paces'
import {
  domains,
  domainsByWeek,
  estimateThresholds,
  thresholdSeries,
  type Threshold,
  type Thresholds,
} from '@/lib/thresholds'
import { BarRow, ChartLegend, ChartScale, LineChart, Sparkline, StackedBar } from './charts'
import { NoBlockCard, useBlock } from './useBlock'
import { island } from './Island'
import {
  Card,
  CardTitle,
  Chevron,
  Chip,
  Delta,
  EmptyState,
  ErrorCard,
  HeroMetric,
  LoadingCard,
  Segmented,
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
 * order is the order of the questions: what have I actually run, what does that project
 * the race to be, what shape am I in to hold it, how did I get there, and finally the
 * whole ledger side by side.
 *
 * The projection sits directly under the volume rather than after the form curves because
 * it is the one card on the page that answers the question the block is *for*, and a
 * screen that makes you scroll past two trend charts to reach its own headline has buried
 * it. Fitness and fatigue read better after it anyway: on their own they are two abstract
 * curves, and behind a projected finishing time they are the explanation for it.
 *
 * Six cards, down from seven, and the merge that got it there was a demotion. The screen
 * used to open on a hero card whose only other content was a full-width cumulative km
 * line against last season — two curves that can only ever go up, whose single reading is
 * the gap between them, which is the number the hero already prints — and then repeat the
 * whole volume question as a second card underneath. The chart is now a sparkline in the
 * hero's trailing slot, at the size that reading is worth, and the volume card it used to
 * push down is the same card: hero, weekly bars, stat strip.
 *
 * Only the owner carries a `baselineKey`, so `baselineFor` returns `null` for every other
 * athlete: every card below degrades to its own numbers with no "frente a" clause, and
 * `HeadToHead` — which is nothing *but* a comparison — does not render at all.
 */
function ProgressScreen() {
  const { data, now, error, reload, progress, currentWeek } = useBlock()

  const view = useMemo(
    () =>
      data?.block
        ? build(
            data.block,
            data.activities,
            baselineFor(data.user.baselineKey, data.block),
            now,
            // The five zones are shares of this athlete's own maximum; the fallback is only
            // for someone who has not answered the question on `/ajustes` yet.
            data.user.hrMax ?? DEFAULT_HR_MAX,
          )
        : null,
    [data, now],
  )

  if (error && !data)
    return <ErrorCard title="Sin datos del bloque" message={error} onRetry={() => void reload()} />
  if (!data || !view || !progress) return <Loading />
  // No dates yet — `/bienvenida` is the only thing that fixes it, and every number on
  // this screen is counted from them.
  if (!data.block) return <NoBlockCard />

  return (
    <>
      <VolumeCard block={data.block} view={view} progress={progress} currentWeek={currentWeek} />
      <ProjectionCard block={data.block} view={view} />
      <FormCard view={view} />
      <ThresholdCard view={view} currentWeek={currentWeek} />
      <IntensityCard view={view} currentWeek={currentWeek} />
      <ConsistencyCard view={view} />
      <HeadToHead block={data.block} view={view} />
    </>
  )
}

// ---------------------------------------------------------------------------
// Everything the page shows, derived once
// ---------------------------------------------------------------------------

type View = ReturnType<typeof build>

function build(
  block: BlockConfig,
  activities: Activity[],
  baseline: Baseline | null,
  now: number,
  hrMax: number,
) {
  const today = startOfDay(now)
  // The block's whole calendar is the x-axis, so the future is visible as space still to
  // fill rather than as a chart that stops where the data does.
  const axis = days(block.startsOn, block.raceOn)
  const todayIndex = Math.max(
    0,
    Math.min(axis.length - 1, Math.round((today - block.startsOn) / DAY_MS)),
  )

  const season = summarise(activities, block.startsOn, today, baseline?.preBlock ?? [])
  const last = baseline ? summarise(baseline.activities, block.startsOn, today) : null

  const fitness = fitnessSeries([...(baseline?.preBlock ?? []), ...activities], block.startsOn, today)
  const lastFitness = baseline ? fitnessSeries(baseline.activities, block.startsOn, block.raceOn) : []

  const thresholds = estimateThresholds(activities, hrMax, now)

  const efforts = bestEfforts(block, activities, hrMax)
  // The baseline is this same athlete's own earlier season, so it is read against the same
  // block and the same maximum — the comparison is only a comparison if both sides are.
  const lastEfforts = baseline ? bestEfforts(block, baseline.activities, hrMax) : []
  const weeks = totalWeeks(block)

  return {
    today,
    axis,
    todayIndex,
    season,
    last,
    baseline,
    /**
     * True while there is nothing to measure the block against in this window: either this
     * athlete has no previous season at all — which is everyone but the owner — or they
     * have one and the block has not yet reached the week it opened in. The two read the
     * same on screen and neither may claim a number.
     */
    tooEarly: last == null || last.totals.runs === 0,
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
    cumulative: cumulativeByDay(activities, block.startsOn, today),
    weekly: weeklyTotals(block, activities, weeks),
    lastWeekly: baseline ? weeklyTotals(block, baseline.activities, weeks) : [],
    efforts,
    lastEfforts,
    projection: projectHalf(efforts, block.raceDistanceM),
    zones: zoneShares(activities, hrMax),
    zoneCoverage: zoneCoverage(activities),
    hrMax,
    thresholds,
    // The estimate as it stood at the end of every week so far, each computed from the
    // activities that existed by then — see `thresholdSeries`.
    thresholdWeeks: thresholdSeries(block, activities, hrMax, now),
    // Split at this athlete's own two thresholds rather than at zone floors, so the card
    // that reads "how much of this was easy" and the card that estimates where easy ends
    // are answering with the same number.
    domains: domains(activities, thresholds),
    domainsWeekly: domainsByWeek(block, activities, thresholds, weeks),
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
      <LoadingCard rows={3} busy={false} />
      <LoadingCard rows={4} busy={false} />
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
  block,
  view,
  progress,
  currentWeek,
}: {
  block: BlockConfig
  view: View
  progress: NonNullable<ReturnType<typeof useBlock>['progress']>
  currentWeek: number
}) {
  const km = view.season.totals.distanceM / 1000
  const lastKm = view.last == null ? 0 : view.last.totals.distanceM / 1000

  const bars = view.weekly.map((week, i) => {
    const value = (week?.distanceM ?? 0) / 1000
    const target = (progress.weekly[i]?.targetVolumeM ?? 0) / 1000
    return {
      key: i,
      value,
      ghost: view.lastWeekly[i] == null ? null : view.lastWeekly[i]!.distanceM / 1000,
      target,
      // Mint is state: the week being run now. Behind it is history, ahead of it is room.
      className: i === currentWeek ? 'bg-accent' : i < currentWeek ? 'bg-label-2' : 'bg-fill',
      title:
        target > 0
          ? `S${i + 1}: ${decimal(value)} de ${decimal(target, 0)} km`
          : `S${i + 1}: ${decimal(value)} km`,
    }
  })

  const compared = view.lastWeekly.some((w) => w != null && w.distanceM > 0)
  const peak = Math.max(0, ...view.weekly.map((w) => w?.distanceM ?? 0))
  const lastPeak = Math.max(0, ...view.lastWeekly.map((w) => w?.distanceM ?? 0))
  const weeks = totalWeeks(block)

  return (
    <Card className="fade-up">
      <HeroMetric
        eyebrow={`Semana ${currentWeek + 1} de ${weeks}`}
        value={decimal(km, 0)}
        unit="km en el bloque"
        context={
          view.baseline == null ? (
            // No season to compare against, so the countdown stands on its own rather than
            // trailing a separator behind a sentence that was never printed.
            <>Faltan {daysToRace(block, view.today)} días</>
          ) : (
            <>
              {view.tooEarly ? (
                <>
                  La temporada pasada aún no había empezado a correr, su bloque abre en la semana{' '}
                  {view.baseline.firstWeek + 1}
                </>
              ) : (
                <>
                  <Delta value={percentDelta(km, lastKm)} className="text-footnote" /> frente a los{' '}
                  {decimal(lastKm, 0)} km de la temporada pasada en este mismo punto
                </>
              )}
              <span className="text-label-3"> · faltan {daysToRace(block, view.today)} días</span>
            </>
          )
        }
        trailing={
          <Sparkline
            values={view.cumulative}
            width={88}
            height={34}
            areaClassName="fill-accent/10"
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
          label={`Kilómetros por semana, de la semana 1 a la ${weeks}, con el objetivo de cada una cruzado sobre su barra${
            compared ? ' y la temporada 2025-26 en sombra detrás' : ''
          }. Van ${decimal(km, 0)} km en el bloque.`}
        />
        {/* The two things the bars encode that a bar cannot say on its own. The week
            colours are not in here: which bar is "now" is read off its position on a
            left-to-right week axis, not off the accent. */}
        <ChartScale start="S1" end={`S${weeks}`}>
          {compared ? 'sombra = 2025-26 · discontinua = objetivo' : 'discontinua = objetivo'}
        </ChartScale>
      </figure>

      <StatStrip className="mt-3">
        <Stat
          label="Por semana"
          value={decimal(view.season.distancePerWeekM / 1000, 0)}
          hint={
            view.last == null
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
            view.last?.totals.longestM
              ? `${formatKm(view.last.totals.longestM)} km la pasada`
              : `de ${decimal(block.raceDistanceM / 1000)} km`
          }
        />
      </StatStrip>
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
 * is that column: `bestEfforts(baseline.activities)` reads the whole of last season, not
 * last season up to this point, because a personal best is the record to beat rather than
 * a snapshot. The whole column — header, cells and delta — disappears for an athlete with
 * no season on file, rather than comparing against a benchmark that is not there.
 *
 * **The rule splits the table into what happened and what has to happen.** Left of it are
 * measurements — this block's best, last season's, the gap between them. Right of it are
 * two numbers about the goal, and they are a pair: `Meta` is the goal read back to that
 * distance and `Riegel` is what that row's own effort projects the race to be, so the two
 * columns of any row answer "what today would have to be" and "what today says it will
 * be" in the same units. Both run through the same exponent, which is what lets them be
 * read against each other at all — and is why `Meta` is not simply goal pace × distance,
 * a number that would sit in this column looking comparable and not be (see
 * `goalEquivalent`). `Media` projecting to itself is not a bug: that row *is* the race.
 *
 * The paragraph that used to sit under the table is gone. What it explained that the table
 * could not say on its own now has a place to live: the projection's own eyebrow names the
 * effort it came from, and the column header names the formula.
 */
function ProjectionCard({ block, view }: { block: BlockConfig; view: View }) {
  const projection = view.projection
  const goalDelta = projection ? projection.timeS - block.goalTimeS : null
  const hasBaseline = view.last != null
  const anyEffort =
    view.efforts.some((e) => e.timeS != null) || view.lastEfforts.some((e) => e.timeS != null)
  // Six columns on a phone is a budget, so it was measured rather than guessed: Inter's
  // digit is 0.646em, which makes `1:23:34` 49.5px at footnote and 45.7px at caption, and
  // `+120%` 43px. Hence w-14 / w-12 / w-11 / w-14 (the rule's border and padding sit
  // inside that one) / w-12 = 252px, and gap-1.5 rather than the usual gap-2 for the five
  // gaps. On a 375px screen that leaves the label 45px, which holds both `Media` (37.7px)
  // and its own header (43.3px) — it is the only cell that may truncate, and the last one
  // that should have to.
  const row = 'flex min-h-11 items-center gap-1.5'
  // The vertical rule, on the first cell right of it. `self-stretch` on the data rows is
  // what makes it a *rule* rather than a tick beside one line of text: an `items-center`
  // flex child is only as tall as its own text, so without it the line would float in the
  // middle of a 44px row.
  const rule = 'border-l border-line pl-2'

  return (
    <Card className="fade-up">
      <CardTitle
        action={
          <span className="text-caption tabular-nums text-label-3">
            Objetivo {formatClock(block.goalTimeS)} · {formatPace(goalPaceSKm(block))}/km
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
            <span className={cn(goalDelta <= 0 ? 'text-accent' : 'text-amber')}>
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
              // `label-3`, not `label-4`: these name the columns under them, which makes
              // them data, and `label-4` is the one step that misses AA.
              //
              // `items-stretch` and the padding moved off the row onto every cell: the
              // rule below is drawn by a cell's own left border, and it has to reach the
              // header's bottom line rather than stopping 6px above it.
              'mt-3 min-h-0 items-stretch border-b border-line text-caption2 uppercase tracking-wider text-label-3',
            )}
          >
            <span className="flex-1 truncate pb-1.5">Listón</span>
            <span className="w-14 shrink-0 pb-1.5 text-right">Bloque</span>
            {hasBaseline ? (
              <>
                <span className="w-12 shrink-0 pb-1.5 text-right">2025-26</span>
                <span className="w-11 shrink-0" />
              </>
            ) : null}
            <span className={cn(rule, 'w-14 shrink-0 pb-1.5 text-right')}>Meta</span>
            <span className="w-12 shrink-0 pb-1.5 text-right">Riegel</span>
          </div>

          <ul className="divide-y divide-line">
            {view.efforts.map((effort, i) => {
              const last = hasBaseline ? view.lastEfforts[i] : undefined
              const delta =
                effort.timeS == null || last?.timeS == null
                  ? null
                  : percentDelta(effort.timeS, last.timeS)
              const projected = projectEffort(effort, block.raceDistanceM)
              const cells = (
                <>
                  <span className="flex-1 truncate text-footnote text-label-2">{effort.label}</span>
                  <span className="data-number w-14 shrink-0 text-right text-footnote">
                    {effort.timeS == null ? (
                      <span className="text-label-3">—</span>
                    ) : (
                      formatClock(effort.timeS)
                    )}
                  </span>
                  {hasBaseline ? (
                    <>
                      <span className="data-number w-12 shrink-0 text-right text-caption text-label-3">
                        {last?.timeS == null ? '' : formatClock(last.timeS)}
                      </span>
                      <span className="w-11 shrink-0 text-right">
                        <Delta value={delta} better="down" />
                      </span>
                    </>
                  ) : null}
                  <span
                    className={cn(
                      rule,
                      'data-number flex w-14 shrink-0 items-center justify-end self-stretch text-caption text-label-3',
                    )}
                  >
                    {formatClock(goalEquivalent(block, effort.distanceM))}
                  </span>
                  <span className="data-number w-12 shrink-0 text-right text-caption text-label-2">
                    {projected == null ? (
                      <span className="text-label-3">—</span>
                    ) : (
                      formatClock(projected)
                    )}
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
 *
 * Both the line and the note it explains are dropped outright when there is no season on
 * file — a dashed line with nothing behind it is not a lighter version of the comparison,
 * it is a different chart wearing the same axes.
 */
function FormCard({ view }: { view: View }) {
  const latest = view.fitness.at(-1)
  const form = latest?.form ?? 0
  const { label, tone } = formLabel(form)
  const lastAtToday = view.lastFitnessLine[view.todayIndex] ?? null
  const hasBaseline = view.last != null

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
            ...(hasBaseline
              ? [{ values: view.lastFitnessLine, className: 'stroke-line-strong', dashed: true }]
              : []),
            { values: view.fatigueLine, className: 'stroke-coral', strokeWidth: 1.5 },
            {
              values: view.fitnessLine,
              className: 'stroke-accent',
              areaClassName: 'fill-accent/10',
            },
          ]}
        />
        <ChartScale
          start={dayFmt.format(new Date(view.axis[0] ?? view.today))}
          end={dayFmt.format(new Date(view.axis.at(-1) ?? view.today))}
        >
          <ChartLegend
            dense
            items={[
              { label: 'Forma', className: 'bg-accent' },
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
        .
        {hasBaseline
          ? ' A trazos, la forma de 2025-26: su histórico arranca con el bloque, así que abre desde abajo.'
          : ''}
      </p>
    </Card>
  )
}

/**
 * Where the two lactate thresholds are, and — the part that is actually worth a card —
 * where they are going.
 *
 * The estimator is `src/lib/thresholds.ts` and its reasoning lives there. What belongs
 * here is the one editorial decision the card makes: **the pulse is the headline and the
 * pace is the story**. A threshold heart rate is close to a constant within an athlete —
 * it is a property of the muscle, not of the week — so a card that charted bpm through a
 * successful block would draw two nearly flat lines and read as "nothing is happening".
 * What training moves is the *speed* carried at those heart rates, which is why the chart
 * opens on pace and the pulse is the option behind the switch rather than the other way
 * round.
 *
 * The card never hides behind an empty state. With no runs at all it still prints two
 * numbers — the textbook shares of maximum heart rate — and says in the prose that they
 * are the textbook and not a measurement. Week one of a block is exactly when an athlete
 * wants to know what to hold, and "vuelve cuando tengas datos" is not an answer.
 */
function ThresholdCard({ view, currentWeek }: { view: View; currentWeek: number }) {
  const [metric, setMetric] = useState<'pace' | 'bpm'>('pace')
  const [notesOpen, setNotesOpen] = useState(false)
  const { thresholds: t, thresholdWeeks } = view

  /** The strap has seen a beat above the configured maximum, so every share here is low. */
  const hrMaxTooLow = t.observedMaxBpm != null && t.observedMaxBpm > view.hrMax

  const pace = metric === 'pace'
  const series = thresholdWeeks.map((week) => ({
    at: week.weekIndex,
    lt1: pace ? week.lt1PaceSKm : week.lt1Bpm,
    lt2: pace ? week.lt2PaceSKm : week.lt2Bpm,
  }))
  const values = series.flatMap((p) => [p.lt1, p.lt2]).filter((v): v is number => v != null)
  // Two of anything makes a trend; one point is a dot, and a dot on an axis is furniture.
  const plotted = values.length >= 4

  // Heart rate and pace both sit a long way from zero, so the floor is just under the
  // lowest point — the same rule `LineChart` states for a heart-rate trace. A zero floor
  // would flatten a fifteen-second improvement into nothing.
  const lo = Math.min(...values)
  const hi = Math.max(...values)
  const room = Math.max(metric === 'bpm' ? 2 : 6, (hi - lo) * 0.2)

  // The axis stops at this week rather than running to the race, which is the opposite of
  // the volume bars and deliberate: an unrun week of volume still says something — the plan
  // asked for a number and it has not happened yet — and an unrun week of *threshold* says
  // nothing at all. Twenty-one empty steps would compress the whole trend into the left
  // eighth of the plot, which is the same reason the cumulative trace above stops at today.
  const steps = currentWeek + 1
  const at = (i: number, of: 'lt1' | 'lt2') => series.find((p) => p.at === i)?.[of] ?? null
  const line = (of: 'lt1' | 'lt2') => Array.from({ length: steps }, (_, i) => at(i, of))

  return (
    <Card className="fade-up">
      <CardTitle
        action={
          // Amber only for `baja`, which is the one reading that changes what you should do
          // with the numbers — it means they are the textbook rather than you. `alta` in the
          // accent would put the screen's loudest colour on a piece of metadata.
          <Chip tone={t.confidence === 'baja' ? 'down' : 'neutral'}>
            confianza {t.confidence}
          </Chip>
        }
      >
        Umbrales
      </CardTitle>

      <div className="mt-2.5 grid grid-cols-2 gap-2.5">
        <ThresholdReading
          label="LT1 · Aeróbico"
          hint="hasta aquí, fácil"
          threshold={t.lt1}
          className="text-blue"
        />
        <ThresholdReading
          label="LT2 · Funcional"
          hint="lo que aguantas una hora"
          threshold={t.lt2}
          className="text-amber"
        />
      </div>

      <ThresholdScale className="mt-3" hrMax={view.hrMax} lt1={t.lt1.bpm} lt2={t.lt2.bpm} />

      {plotted ? (
        <>
          <Segmented<'pace' | 'bpm'>
            className="mt-3"
            options={[
              { value: 'pace', label: 'Ritmo' },
              { value: 'bpm', label: 'Pulso' },
            ]}
            value={metric}
            onChange={setMetric}
            label="Qué trazar de los umbrales"
          />

          <figure className="mt-2.5">
            <LineChart
              label={
                pace
                  ? 'Ritmo en cada umbral, semana a semana. Más arriba es más rápido.'
                  : 'Pulsaciones en cada umbral, semana a semana.'
              }
              steps={steps}
              height={88}
              yMin={lo - room}
              yMax={hi + room}
              invert={pace}
              series={[
                { values: line('lt1'), className: 'stroke-blue', strokeWidth: 1.5, points: true, pointClassName: 'stroke-blue', pointHaloClassName: 'stroke-surface-raised' },
                { values: line('lt2'), className: 'stroke-amber', strokeWidth: 1.5, points: true, pointClassName: 'stroke-amber', pointHaloClassName: 'stroke-surface-raised' },
              ]}
            />
            <ChartScale start="S1" end={`S${steps}`}>
              <ChartLegend
                dense
                items={[
                  { label: 'LT1', className: 'bg-blue' },
                  { label: 'LT2', className: 'bg-amber' },
                ]}
              />
            </ChartScale>
          </figure>
        </>
      ) : null}

      {/*
        The method, folded away.

        It is six lines of prose explaining an estimate, and prose you have read once is
        furniture on every visit after that — the numbers above are what the card is for.
        Collapsed by default and reopened by choice, which is also why the state lives in
        this component rather than in a ref: `/progreso` is one of the four tabs `Activity`
        keeps mounted, so a reader who opened it stays opened across tab taps.

        The FCmáx warning folds in with it, at the cost of one concession. It is the only
        actionable line in the card — every percentage on this screen is a share of that
        number — so burying it with no trace would be a regression rather than a tidy-up.
        The trigger carries it instead: amber, and naming the thing to fix, so the warning
        is still legible while closed and one tap from its detail.
      */}
      <div className="mt-3 border-t border-line pt-1">
        <button
          type="button"
          onClick={() => setNotesOpen((open) => !open)}
          aria-expanded={notesOpen}
          aria-controls="umbrales-metodo"
          className="tappable flex min-h-11 w-full items-center gap-1.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent"
        >
          {/* Not the uppercase label treatment the stat rows wear: this row has to be able
              to say "FCmáx", and `text-transform` would print it FCMÁX. The chevron, the
              rule above and the 44px row are what make it read as a control. */}
          <span className="flex-1 truncate text-caption2 font-medium text-label-3">
            Cómo se calcula
            {hrMaxTooLow ? <span className="text-amber"> · revisa tu FCmáx</span> : null}
          </span>
          <Chevron open={notesOpen} />
        </button>

        {notesOpen ? (
          <div id="umbrales-metodo" className="pb-1">
            <p className="text-caption2 leading-relaxed text-label-3">
              <ThresholdMethod thresholds={t} />
            </p>

            {hrMaxTooLow ? (
              <p className="mt-2 text-caption2 leading-relaxed text-amber">
                Tu pulsómetro ha marcado {t.observedMaxBpm} lpm, por encima de la FCmáx que
                tienes puesta ({view.hrMax}). Ajústala en Ajustes: todo lo de esta pantalla son
                porcentajes de ese número.
              </p>
            ) : null}
          </div>
        ) : null}
      </div>
    </Card>
  )
}

/** One threshold: the pulse big, the pace and the share of maximum under it. */
function ThresholdReading({
  label,
  hint,
  threshold,
  className,
}: {
  label: string
  hint: string
  threshold: Threshold
  className: string
}) {
  return (
    <div className="min-w-0 rounded-lg bg-surface-deep/40 px-2.5 py-2">
      <p className={cn('truncate text-caption2 font-semibold uppercase tracking-[0.09em]', className)}>
        {label}
      </p>
      <p className="data-number mt-1 font-display text-title2 font-bold leading-none text-label">
        {threshold.bpm}
        <span className="ml-1 font-sans text-caption font-normal tracking-normal text-label-3">
          lpm
        </span>
      </p>
      <p className="mt-1 text-caption2 tabular-nums text-label-2">
        {threshold.paceSKm == null ? '—' : `${formatPace(threshold.paceSKm)}/km`} ·{' '}
        {Math.round(threshold.shareOfMax * 100)}% FCmáx
      </p>
      <p className="mt-0.5 truncate text-caption2 text-label-3">{hint}</p>
    </div>
  )
}

/**
 * The five zones as a ruler, with the two thresholds marked on it.
 *
 * Local to this card rather than an eighth shape in `charts.tsx`: that file holds the
 * shapes more than one screen draws, and this one is a picture of a single idea — where
 * two numbers sit against the zones the rest of the app already speaks in. It is also the
 * one place in the app an actual heart rate is printed, which is a deliberate exception to
 * "intensity is Z1–Z5, never a heart rate": a threshold *is* the bpm, that is the whole
 * point of estimating it, and the zones under it are what make the number legible.
 *
 * The scale opens at 60% of maximum rather than at zero, because nothing below it is ever
 * run and a ruler that spends half its width on heart rates the athlete never sees is half
 * a ruler.
 */
function ThresholdScale({
  hrMax,
  lt1,
  lt2,
  className,
}: {
  hrMax: number
  lt1: number
  lt2: number
  className?: string
}) {
  const floors = zoneFloorsBpm(hrMax)
  const from = Math.round(0.6 * hrMax)
  const span = hrMax - from
  const at = (bpm: number) => ((bpm - from) / span) * 100

  const bands: { zone: Zone; from: number; to: number }[] = [
    { zone: 1, from, to: floors[2] },
    { zone: 2, from: floors[2], to: floors[3] },
    { zone: 3, from: floors[3], to: floors[4] },
    { zone: 4, from: floors[4], to: floors[5] },
    { zone: 5, from: floors[5], to: hrMax },
  ]

  const marks = [
    { label: 'LT1', bpm: lt1, className: 'bg-blue', text: 'text-blue' },
    { label: 'LT2', bpm: lt2, className: 'bg-amber', text: 'text-amber' },
  ]

  return (
    <div className={className}>
      <div
        role="img"
        aria-label={`Las cinco zonas entre ${from} y ${hrMax} lpm, con el LT1 en ${lt1} y el LT2 en ${lt2}.`}
        className="relative h-4 overflow-hidden rounded-full bg-fill"
      >
        <div aria-hidden className="flex h-full">
          {bands.map((band) => (
            <span
              key={band.zone}
              // A third of the opacity the zone bar uses elsewhere: this is a backdrop for
              // two markers, not a reading of its own, and at full chroma the markers
              // disappear into it.
              className={cn('h-full opacity-35', ZONE_ACCENT[band.zone].bar)}
              style={{ width: `${((band.to - band.from) / span) * 100}%` }}
            />
          ))}
        </div>
        {marks.map((mark) => (
          <span
            key={mark.label}
            aria-hidden
            // Ringed in the card's own ground, because a marker has no say in which band
            // it lands on: LT2 sits inside Z4 and LT1 on the Z2/Z3 seam, so amber-on-amber
            // and blue-on-blue are the *expected* cases, not the edge ones. The ring is
            // the gap that separates the mark from whatever is behind it.
            className={cn(
              'absolute inset-y-0 w-0.5 rounded-full ring-2 ring-surface-raised',
              mark.className,
            )}
            style={{ left: `calc(${Math.min(100, Math.max(0, at(mark.bpm)))}% - 1px)` }}
          />
        ))}
      </div>

      <div aria-hidden className="relative mt-1 h-3.5">
        {marks.map((mark) => (
          <span
            key={mark.label}
            className={cn(
              'absolute -translate-x-1/2 whitespace-nowrap text-caption2 font-semibold tabular-nums',
              mark.text,
            )}
            // Clamped off both ends so a threshold near the top of the scale keeps its
            // label inside the card instead of hanging off the gutter.
            style={{ left: `${Math.min(88, Math.max(12, at(mark.bpm)))}%` }}
          >
            {mark.label} {mark.bpm}
          </span>
        ))}
      </div>
      <div className="flex items-baseline justify-between text-caption2 tabular-nums text-label-3">
        <span>{from} lpm</span>
        <span>{hrMax} lpm · FCmáx</span>
      </div>
    </div>
  )
}

/** How the two numbers above were arrived at, in the words the basis actually justifies. */
function ThresholdMethod({ thresholds }: { thresholds: Thresholds }) {
  if (thresholds.lt2.basis === 'hrmax')
    return (
      <>
        Todavía no hay ningún esfuerzo sostenido con pulso en las últimas semanas, así que
        estos dos son el 90% y el 80% de tu FCmáx — el punto de partida de manual, no una
        medida tuya. Una salida dura y continua de veinte minutos o más y el LT2 pasa a
        medirse.
      </>
    )

  const n = thresholds.evidence.length
  return (
    <>
      El LT2 sale de {n === 1 ? 'tu esfuerzo sostenido' : `tus ${n} esfuerzos sostenidos`} de
      las últimas semanas, llevad{n === 1 ? 'o' : 'os'} a lo que habría{n === 1 ? '' : 'n'} dado
      en una hora
      {thresholds.lt1.basis === 'measured'
        ? '; el LT1, del punto en que tu pulso empieza a subir más deprisa que el ritmo.'
        : '; el LT1 va un 10% de FCmáx por debajo hasta que haya salidas suficientes para encontrarlo en tus datos.'}{' '}
      Las pulsaciones de un umbral apenas se mueven: lo que mejora es el ritmo que sostienes en
      ellas.
      {thresholds.line == null ? ' Aún faltan salidas con pulso para poder darles uno.' : ''}
    </>
  )
}

/**
 * Where the time actually went, which is the check on the plan's second promise: that
 * frequency goes up and intensity does not.
 *
 * Three readings, coarse to fine, and the order is the order of the questions. The strip
 * splits the block at this athlete's own two thresholds, because "how much of this was
 * genuinely easy" is the question polarised training is about and five zones is more
 * resolution than that question has. The bar and the list under it are the five zones,
 * for the session-level reading. And the weekly row is the one thing a total cannot show:
 * whether the easy end erodes as the volume climbs.
 *
 * The bar is drawn whether or not there is anything in it — an empty track plus the
 * sentence that says why is the shape of the answer, and it stops the card collapsing to
 * a title for the weeks before the strap records anything.
 */
function IntensityCard({ view, currentWeek }: { view: View; currentWeek: number }) {
  const present = view.zones.filter((z) => z.movingS > 0)
  const total = present.reduce((sum, z) => sum + z.movingS, 0)
  const { domains: split } = view

  const share = (seconds: number) =>
    split.totalS === 0 ? '—' : `${Math.round((seconds / split.totalS) * 100)}%`

  /**
   * The *hard* share of every week run so far, against a rule at a fifth.
   *
   * The easy share was the obvious series and it is the wrong one, for a mechanical reason
   * and an editorial one. Mechanically, `BarRow` scales to the tallest thing in it — bars
   * and target alike — so an 80% rule over weeks that never reach it pins itself to the top
   * edge and reads as a lid rather than as a reference. A 20% rule sits in the middle of the
   * plot where a rule belongs. Editorially it is the sharper reading anyway: this card's own
   * sentence is that frequency should rise and intensity should not, and the polarity is
   * right — bars growing towards the line is the thing to notice, not bars shrinking away
   * from one.
   *
   * Only as far as this week. The weeks ahead would be a row of empty slots, which reads as
   * twenty weeks of nothing rather than as twenty weeks not yet run; the volume card can
   * draw its future because a target rule gives an unrun week something to say, and there
   * is nothing to put in one here.
   */
  const weekly = view.domainsWeekly.slice(0, currentWeek + 1).map((week, i) => {
    const hard = week.totalS === 0 ? 0 : (week.hardS / week.totalS) * 100
    return {
      key: i,
      value: hard,
      target: 20,
      // The same neutral-past / accent-now the weekly volume bars use, so two rows of bars
      // on one screen do not mean two different things by the same colour. The reading is
      // in the rule, not in the hue — one step dimmer than the volume row's `label-2`
      // because this card already carries five zone colours above it.
      className: i === currentWeek ? 'bg-accent' : 'bg-label-3',
      title:
        week.totalS === 0
          ? `S${i + 1}: sin pulso`
          : `S${i + 1}: ${Math.round(hard)}% duro`,
    }
  })

  return (
    <Card className="fade-up">
      <CardTitle>Reparto por zonas</CardTitle>

      <StatStrip>
        <Stat label="Fácil" value={share(split.easyS)} hint={`bajo ${view.thresholds.lt1.bpm} lpm`} />
        <Stat
          label="Moderado"
          value={share(split.moderateS)}
          hint={`${view.thresholds.lt1.bpm}–${view.thresholds.lt2.bpm}`}
        />
        <Stat label="Duro" value={share(split.hardS)} hint={`sobre ${view.thresholds.lt2.bpm} lpm`} />
      </StatStrip>

      <StackedBar
        className="mt-3"
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
              <span className="flex min-w-0 items-center gap-1.5">
                <span className={cn('size-2 shrink-0 rounded-full', ZONE_ACCENT[zone.zone].bar)} />
                <span className="truncate text-footnote text-label-2">{ZONE_NAME[zone.zone]}</span>
                {/* The kilometres run in the zone, which the time alone does not say: an
                    hour of Z2 and an hour of Z4 are very different distances, and volume
                    is what every other card on this screen counts in. */}
                <span className="shrink-0 text-caption2 tabular-nums text-label-3">
                  {formatKm(zone.distanceM)} km
                </span>
              </span>
              <span className="shrink-0 text-caption tabular-nums text-label-3">
                {formatDuration(zone.movingS)} · {Math.round((zone.movingS / total) * 100)}%
              </span>
            </li>
          ))}
        </ul>
      ) : null}

      {weekly.length > 1 ? (
        <figure className="mt-3">
          <BarRow
            label="Porcentaje del tiempo corriendo por encima del LT2, semana a semana. La discontinua marca el 20%."
            height={44}
            bars={weekly}
          />
          <ChartScale start="S1" end={`S${weekly.length}`}>
            % duro · discontinua = 20%
          </ChartScale>
        </figure>
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
  const then = view.last?.consistency

  return (
    <Card className="fade-up">
      <CardTitle>Constancia</CardTitle>

      <StatStrip>
        <Stat
          label="Salidas/sem"
          value={decimal(now.runsPerWeek)}
          hint={view.tooEarly ? 'objetivo 5–6' : `${decimal(then!.runsPerWeek)} la pasada`}
        />
        <Stat
          label="Parón mayor"
          value={now.longestGapDays}
          hint={view.tooEarly ? 'días sin correr' : `${then!.longestGapDays} la pasada`}
        />
        <Stat
          label="Parones 6d+"
          value={now.breaks}
          hint={view.tooEarly ? 'el patrón a romper' : `${then!.breaks} la pasada`}
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
 * Nothing renders at all until there is a season to measure against and the block has
 * reached the week it opened in: for an athlete with no `baselineKey`, or for block weeks
 * 1–3, there is no counterpart to compare against, and either the hero above has already
 * said so or there is nothing to say at all. A card here would be a second explanation of
 * the same absence, or an explanation of an absence nobody asked about.
 */
function HeadToHead({ block, view }: { block: BlockConfig; view: View }) {
  // All three, and `baseline` explicitly rather than as a consequence of the other two:
  // this card is nothing *but* a comparison, and the athlete it is drawn for may simply
  // not have a season to compare against.
  if (view.baseline == null || view.last == null || view.tooEarly) return null
  const last = view.last

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
      then: last.totals.runs,
      format: (v) => String(Math.round(v)),
    },
    {
      label: 'Tiempo en pie',
      now: view.season.totals.movingS,
      then: last.totals.movingS,
      format: formatDuration,
    },
    {
      label: 'Desnivel',
      now: view.season.totals.elevationM,
      then: last.totals.elevationM,
      format: (v) => `${decimal(v, 0)} m`,
    },
    {
      label: 'Ritmo medio',
      now: view.season.totals.meanPaceSKm ?? 0,
      then: last.totals.meanPaceSKm ?? 0,
      format: (v) => `${formatPace(v)}/km`,
      // Faster is lower, so a shrinking number is the good one.
      better: 'down',
    },
    {
      label: 'Días parado',
      now: view.season.consistency.days - view.season.consistency.daysRun,
      then: last.consistency.days - last.consistency.daysRun,
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
        {daysToRace(block, view.today)} días, que la temporada pasada fue el{' '}
        {dateFmt.format(new Date(view.today - view.baseline.shiftMs))}.
      </p>
    </Card>
  )
}

/**
 * The screen as the page mounts it: wrapped so a render that throws leaves a card with a
 * way out on it rather than an empty column under the heading. See `Island.tsx`.
 */
export const Progress = island(ProgressScreen)
