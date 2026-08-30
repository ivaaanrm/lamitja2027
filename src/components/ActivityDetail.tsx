import { useEffect, useMemo, useState } from 'react'
import {
  formatClock,
  formatDuration,
  formatKm,
  formatPace,
  formatPaceRange,
  isRun,
  paceSKm,
} from '@/lib/activity'
import { activityLoad } from '@/lib/analytics'
import { cn } from '@/lib/cn'
import type { Activity, PlanSession } from '@/lib/db/schema'
import { decimal } from '@/lib/format'
import { DEFAULT_HR_MAX, ZONE_NAME, hrZone, zoneFloorsBpm, zoneTag, type Zone } from '@/lib/paces'
import type { ActivityDetail as Detail, Split, TracePoint } from '@/lib/streams'
import { ChartScale, LineChart, Sparkline, SplitBars, StackedBar } from './charts'
import { NoBlockCard, useBlock } from './useBlock'
import { island } from './Island'
import { useRouteParams, type Route } from './router'
import {
  ARROW_OUT,
  CHEVRON_LEFT,
  ActionLink,
  Card,
  CardTitle,
  EmptyState,
  ErrorCard,
  HeroMetric,
  Segmented,
  Skeleton,
  Stat,
  StatStrip,
  TextLink,
  TypeChip,
  ZONE_ACCENT,
} from './ui'

/**
 * One activity, opened from the log: what the watch recorded, drawn over distance.
 *
 * Two sources, painted in two steps. The summary — name, distance, time, averages — is
 * already in the `/api/data` payload the log was rendered from, so the first card paints
 * on the first frame; the trace behind it comes from Strava through `/api/activities/:id`
 * and lands a moment later. That second wait is real (three API calls, then ten thousand
 * samples folded into 120 bins on the Worker), which is why everything below the summary
 * waits as a skeleton in the shape of the card it becomes rather than as a word: when the
 * trace arrives, nothing on the screen moves. The id lives in the query string and is read
 * in an effect, because this island is also rendered at build time in a Worker with no
 * `location`.
 *
 * One question per card, and the card is the answer: what the run was (the distance, its
 * pace trace beside it, and the four numbers that qualify it), what it looked like (one
 * trace at a time, switched rather than stacked three deep), where the pulse sat, and the
 * splits underneath. This is the most trace-led screen in the app, so the plot is given
 * the room three small ones were sharing.
 */

/**
 * The traces read so far in this document, the way `useBlock` keeps the last block payload
 * — and for a sharper reason than speed.
 *
 * Every open of this screen costs *three* calls against Strava's 100-per-15-minutes read
 * limit, and the gesture this screen invites is browsing: tap a run, back, tap the next
 * one, back to the first to compare. Without this, thirty-odd taps through the log spend
 * the whole quarter-hour budget and the traces simply stop arriving — a rate limit reached
 * by reading, which is the one way this app was never meant to hit one. Held for the life
 * of the document only: a tab tap keeps it, a reload drops it, and a corrected activity is
 * therefore never more than one document load away.
 */
const traces = new Map<number, Detail>()

function ActivityDetailScreen({ route }: { route: Route }) {
  const { data, weeks, error, reload } = useBlock()
  /**
   * `undefined` is "the query string has not been read yet" and `null` is "there is no
   * usable id in it" — the same tri-state `SessionDetail` carries, and for the same
   * reason. Collapsing the two flashed the dead-end card for a frame on every open from
   * `/registro`, back when the id arrived from an effect and effects run after the browser
   * has painted. It comes off the route now, so the only render that still answers
   * `undefined` is the hydration pass — where the id genuinely is not knowable, because
   * `/actividad` is one prerendered shell for every run in the log.
   */
  const params = useRouteParams(route)
  const id = useMemo(() => {
    if (!params) return undefined
    const value = Number(params.get('id'))
    return Number.isInteger(value) && value > 0 ? value : null
  }, [params])
  const [detail, setDetail] = useState<Detail | null>(null)
  const [detailError, setDetailError] = useState<string | null>(null)
  /** Bumped to ask Strava again — the retry after a rate limit or a dropped connection. */
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    if (id == null) return
    let cancelled = false

    // Already read once in this document — the run tapped, backed out of and tapped again,
    // which is how a log gets browsed. See `traces`.
    const held = traces.get(id)
    if (held && attempt === 0) {
      setDetail(held)
      return
    }

    fetch(`/api/activities/${id}`)
      .then(async (response) => {
        if (response.status === 401) {
          location.href = '/login'
          return
        }
        const body = (await response.json()) as Detail | { error: string }
        if (cancelled) return
        if (!response.ok || 'error' in body) {
          setDetailError('error' in body ? body.error : `No se pudo cargar la actividad (${response.status})`)
          return
        }
        traces.set(id, body)
        setDetail(body)
      })
      .catch((cause: unknown) => {
        if (!cancelled) setDetailError(cause instanceof Error ? cause.message : 'No se pudo contactar con el servidor')
      })
    return () => {
      cancelled = true
    }
  }, [id, attempt])

  const activity = useMemo(() => data?.activities.find((a) => a.id === id) ?? null, [data, id])

  /** The prescribed session this run answered, if any. */
  const answered = useMemo(() => {
    for (const week of weeks) {
      for (const match of week.sessions) {
        if (match.activity?.id === id) return match.session
      }
    }
    return null
  }, [weeks, id])

  if (error && !data)
    return (
      <ErrorCard title="Sin datos de la actividad" message={error} onRetry={() => void reload()} />
    )
  // The block payload carries the summary the first card is built from, so until it lands
  // the screen stands in for itself in grey. A spinner here would say "wait" and nothing
  // about what for.
  if (!data || id === undefined) return <ScreenSkeleton />
  // No dates yet — `/bienvenida` is the only thing that fixes it, and every number on
  // this screen is counted from them.
  if (!data.block) return <NoBlockCard />

  const block = data.block
  const hrMax = data.user.hrMax ?? DEFAULT_HR_MAX

  if (id === null) {
    return (
      <Card className="fade-up">
        <CardTitle>Actividad</CardTitle>
        <EmptyState action={<BackLink />}>
          La dirección no dice qué salida abrir. Vuelve al registro y toca una.
        </EmptyState>
      </Card>
    )
  }
  if (!activity) {
    return (
      <Card className="fade-up">
        <CardTitle>Actividad</CardTitle>
        <EmptyState action={<BackLink />}>
          Esa salida no está en el bloque: solo se sincroniza lo corrido desde el{' '}
          {blockStartFmt.format(new Date(block.startsOn))}.
        </EmptyState>
      </Card>
    )
  }

  return (
    <>
      <Overview
        activity={activity}
        answered={answered}
        trace={detail?.trace ?? null}
        pending={detail === null && detailError === null}
        hrMax={hrMax}
      />

      {detailError ? (
        // The summary above came from the block and is unaffected, so the hint says so:
        // the failure is one request, not the screen. And the request is worth retrying —
        // it is three calls against Strava's 100-per-15-minutes, so the usual cause is a
        // dropped connection rather than a limit.
        <ErrorCard
          title="Traza"
          message={detailError}
          hint="El resumen de arriba es el de Strava. Lo que falta es el registro segundo a segundo."
          onRetry={() => {
            setDetailError(null)
            setAttempt((n) => n + 1)
          }}
        />
      ) : detail ? (
        <>
          <Traces activity={activity} trace={detail.trace} answered={answered} hrMax={hrMax} />
          <Zones zoneS={detail.zoneS} />
          {detail.laps.length > 0 ? (
            <SplitTable
              title="Series"
              rows={detail.laps}
              labelFor={(lap) => String(lap.index)}
              backdrop={detail.trace.map((p) => p.altitudeM)}
              hrMax={hrMax}
            />
          ) : null}
          {detail.splits.length > 0 ? (
            <SplitTable
              title="Parciales"
              rows={detail.splits}
              labelFor={(_, i) => String(i + 1)}
              backdrop={detail.trace.map((p) => p.altitudeM)}
              hrMax={hrMax}
            />
          ) : null}
          {detail.description ? (
            <Card className="fade-up">
              <CardTitle>Notas</CardTitle>
              <p className="whitespace-pre-line text-footnote leading-relaxed text-label-2">
                {detail.description}
              </p>
            </Card>
          ) : null}
        </>
      ) : (
        <TraceSkeleton />
      )}
    </>
  )
}

const dateFmt = new Intl.DateTimeFormat('es-ES', {
  weekday: 'long',
  day: 'numeric',
  month: 'long',
  hour: '2-digit',
  minute: '2-digit',
  timeZone: 'UTC',
})

/** `17 de agosto de 2026` — the block's own opening day, said in full in the dead end below. */
const blockStartFmt = new Intl.DateTimeFormat('es-ES', {
  day: 'numeric',
  month: 'long',
  year: 'numeric',
  timeZone: 'UTC',
})

/**
 * The way back out of a dead end.
 *
 * `quiet`, not `primary`: an escape from a screen that cannot show anything is not the
 * same offer as "here is the thing to do next", and accent is reserved for the second.
 */
function BackLink() {
  return <TextLink href="/registro">Volver al registro</TextLink>
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

/** `Z4 · Umbral` → `Umbral`. The tag is already the value, so the hint says the word. */
const zoneWord = (zone: Zone) => ZONE_NAME[zone].split('·').at(-1)!.trim()

/**
 * Slower than 8:00/km is not this athlete running: it is a crossing, a photo or a walk up
 * a ramp. Both drawings of the pace trace drop those bins.
 *
 * On the chart, leaving one in stretches the y axis three times over and flattens the whole
 * run into a band — and `LineChart`'s `yMax` cannot clip it, because that prop is a *floor*
 * for the axis (`Math.max(yMax, ...values)`), not a ceiling. Dropping the bin instead breaks
 * the line exactly where the running stopped, which is the same vocabulary a GPS dropout
 * already speaks here. On the hero's sparkline it matters more, not less: 28px of height
 * spent on a stop at a traffic light is a sparkline of a traffic light.
 */
const WALK_S_KM = 480

const runningPace = (value: number | null) => (value == null || value > WALK_S_KM ? null : value)

/**
 * What the run was: its name, the distance as the screen's one hero, and the four numbers
 * that qualify it.
 *
 * Distance is the hero because it is what identifies a run — pace and time are how it was
 * covered, so they ride in the hero's context line instead of taking a column of their
 * own. The trailing slot is the pace trace as a sparkline: on the screen whose whole
 * subject is the trace, the waveform motif is not decoration, it is the data. It is held
 * open by a skeleton of its own size while the fetch is in flight, or the hero would jump
 * sideways when it arrives.
 *
 * The remaining four are two `StatStrip`s of two rather than one of four: at 375px a
 * four-column strip leaves ~62px of content per cell, and `CADENCIA` does not fit in it.
 */
function Overview({
  activity,
  answered,
  trace,
  pending,
  hrMax,
}: {
  activity: Activity
  answered: PlanSession | null
  /** `null` until the detail request lands — or for good, if it fails. */
  trace: TracePoint[] | null
  pending: boolean
  hrMax: number
}) {
  const run = isRun(activity.sportType)
  const zone = activity.averageHeartrate == null ? null : hrZone(activity.averageHeartrate, hrMax)

  // Negated, because a sparkline draws bigger values higher and a slower kilometre is a
  // bigger number. The axis is unlabelled, so the inversion costs nothing and the trace
  // reads the way every pace chart in the app does: fast is up.
  const paceTrace = (trace ?? []).map((point) => {
    const value = runningPace(point.paceSKm)
    return value == null ? null : -value
  })

  return (
    <Card className="fade-up">
      <div className="-mx-1 -mt-2 flex items-center justify-between gap-2">
        <ActionLink icon={CHEVRON_LEFT} href="/registro">
          Registro
        </ActionLink>
        {/* Strava is the escape hatch for everything this screen deliberately does not
            store — the map, the photos, the segments — so it sits with the navigation
            rather than in a card of its own at the bottom. */}
        <ActionLink
          icon={ARROW_OUT}
          after
          newTab
          href={`https://www.strava.com/activities/${activity.id}`}
        >
          Ver en Strava
        </ActionLink>
      </div>

      <h2 className="font-display text-title3 font-bold leading-tight tracking-tight text-label">
        {activity.name}
      </h2>
      <p className="mt-1 text-footnote text-label-3">{dateFmt.format(new Date(activity.startedOn))}</p>

      {answered ? (
        <p className="mt-2 flex items-center gap-1.5">
          <TypeChip type={answered.type} />
          <span className="min-w-0 flex-1 truncate text-caption text-label-2">
            Cumplió · {answered.title}
          </span>
        </p>
      ) : null}

      <HeroMetric
        className="mt-3"
        value={formatKm(activity.distanceM)}
        unit="km"
        context={
          <span className="tabular-nums">
            {run
              ? `${formatPace(paceSKm(activity.distanceM, activity.movingS))}/km · ${formatClock(activity.movingS)} en movimiento`
              : `${formatDuration(activity.movingS)} en movimiento`}
          </span>
        }
        trailing={
          !run ? undefined : pending ? (
            <Skeleton className="h-7 w-24" />
          ) : (
            <Sparkline
              values={paceTrace}
              className="stroke-label"
              label="Ritmo a lo largo de la salida; más rápido, arriba"
            />
          )
        }
      />

      <StatStrip className="mt-3 border-t border-line pt-3">
        <Stat
          label="Zona"
          value={zone ? zoneTag(zone) : '—'}
          hint={
            zone ? <span className={ZONE_ACCENT[zone].text}>{zoneWord(zone)}</span> : 'sin pulso'
          }
        />
        <Stat
          label="Cadencia"
          value={
            activity.cadenceSpm == null ? (
              '—'
            ) : (
              // The knee protocol's primary marker: 170 spm is the floor, so meeting it is
              // a state and gets the state colour. The trace card draws the same 170 as a
              // rule, which is where the number to compare against is spelled out.
              <span className={activity.cadenceSpm >= 170 ? 'text-accent' : 'text-amber'}>
                {activity.cadenceSpm}
              </span>
            )
          }
          hint={activity.cadenceSpm == null ? 'sin dato' : 'pasos/min'}
        />
      </StatStrip>

      <StatStrip className="mt-3">
        <Stat label="Desnivel" value={`${decimal(activity.elevationGainM ?? 0, 0)} m`} hint="acumulado" />
        <Stat
          label="Esfuerzo"
          value={Math.round(activityLoad(activity))}
          hint={activity.sufferScore == null ? 'estimado' : 'relativo'}
        />
      </StatStrip>
    </Card>
  )
}

// ---------------------------------------------------------------------------
// Traces
// ---------------------------------------------------------------------------

type Metric = 'pace' | 'hr' | 'cadence'

/** The pace the session asked for, as reference rules on the trace. */
function paceRules(session: PlanSession | null): { at: number; className?: string }[] {
  return [session?.targetPaceLoSKm, session?.targetPaceHiSKm]
    .filter(isNumber)
    .map((at) => ({ at, className: 'stroke-accent/60' }))
}

/**
 * The trace, one metric at a time.
 *
 * Three stacked cards of 120px was the same card three times, and the reader compared
 * nothing across them — the x axis is shared, so the honest comparison is *switching*,
 * not scrolling. A segmented control buys a plot half again as tall, one axis caption
 * instead of three, and a card that reads as one question. Altitude stays where it was
 * useful: as the ground under every line, on its own scale.
 */
function Traces({
  activity,
  trace,
  answered,
  hrMax,
}: {
  activity: Activity
  trace: TracePoint[]
  answered: PlanSession | null
  hrMax: number
}) {
  const [chosen, setChosen] = useState<Metric>('pace')

  const run = isRun(activity.sportType)
  const pace = trace.map((p) => runningPace(p.paceSKm))
  const hr = trace.map((p) => p.heartrate)
  const cadence = trace.map((p) => p.cadenceSpm)
  const altitude = trace.map((p) => p.altitudeM)
  const totalKm = (trace.at(-1)?.distanceM ?? 0) / 1000

  // Built by hand rather than filtered, so the array is typed without a predicate.
  const options: { value: Metric; label: string }[] = []
  if (run && pace.some(isNumber)) options.push({ value: 'pace', label: 'Ritmo' })
  if (hr.some(isNumber)) options.push({ value: 'hr', label: 'Pulso' })
  if (cadence.some(isNumber)) options.push({ value: 'cadence', label: 'Cadencia' })

  if (options.length === 0) {
    return (
      <Card className="fade-up">
        <CardTitle>Traza</CardTitle>
        <EmptyState>
          El reloj no guardó ni ritmo, ni pulso, ni cadencia en esta salida. Solo queda el
          resumen.
        </EmptyState>
      </Card>
    )
  }

  // A ride has no pace segment, so the default has to be able to fall through. Derived
  // rather than corrected in an effect: the fallback is a function of the data.
  const metric = options.some((option) => option.value === chosen) ? chosen : options[0]!.value
  const view = viewFor(metric, { activity, answered, pace, hr, cadence, altitude, hrMax })

  return (
    <Card className="fade-up">
      {options.length > 1 ? (
        <Segmented options={options} value={metric} onChange={setChosen} label="Qué trazar" />
      ) : (
        <CardTitle>{options[0]!.label}</CardTitle>
      )}

      <div className="mt-3 flex items-baseline justify-between gap-3">
        <p className="data-number font-display text-title3 font-bold leading-none text-label">
          {view.value}
          <span className="ml-1 font-sans text-caption font-normal tracking-normal text-label-3">
            {view.unit}
          </span>
        </p>
        {view.span ? (
          <p className="shrink-0 text-caption tabular-nums text-label-3">rango {view.span}</p>
        ) : null}
      </div>

      <figure className="mt-2.5">
        {/* Keyed by metric so switching remounts the paths and the line draws itself on
            again — the reveal is the feedback that the plot changed under the control. */}
        <div key={metric}>{view.chart}</div>
        <ChartScale start="0 km" end={`${decimal(totalKm)} km`}>
          {view.legend}
        </ChartScale>
      </figure>

      {/* The one piece of ink on this card that no axis explains: say what it is, once,
          whichever metric is on top of it. */}
      {altitude.filter(isNumber).length > 1 ? (
        <p className="mt-2 text-caption2 leading-relaxed text-label-3">
          El relieve de fondo es la altitud: {range(altitude, (v) => decimal(v, 0))} m.
        </p>
      ) : null}
    </Card>
  )
}

/** Everything that changes when the segmented control moves, in one place. */
function viewFor(
  metric: Metric,
  {
    activity,
    answered,
    pace,
    hr,
    cadence,
    altitude,
    hrMax,
  }: {
    activity: Activity
    answered: PlanSession | null
    pace: (number | null)[]
    hr: (number | null)[]
    cadence: (number | null)[]
    altitude: (number | null)[]
    hrMax: number
  },
): { value: string; unit: string; span: string; legend: string; chart: React.ReactNode } {
  const steps = pace.length

  if (metric === 'pace') {
    const present = pace.filter(isNumber)
    const band = formatPaceRange(answered?.targetPaceLoSKm ?? null, answered?.targetPaceHiSKm ?? null)
    return {
      value: formatPace(paceSKm(activity.distanceM, activity.movingS)),
      unit: '/km de media',
      span: range(pace, formatPace),
      legend: band ? `objetivo ${band}` : 'más rápido, arriba',
      chart: (
        <LineChart
          label="Ritmo por kilómetro a lo largo de la distancia, con la altitud de fondo"
          steps={steps}
          height={132}
          backdrop={altitude}
          series={[{ values: pace, className: 'stroke-label', areaClassName: 'fill-label/10' }]}
          // Fast is up, and the floor sits a hair under the quickest bin so a single surge
          // does not flatten the rest of the run.
          yMin={Math.max(0, Math.min(...present) - 10)}
          yMax={Math.max(...present) + 10}
          invert
          rules={paceRules(answered)}
        />
      ),
    }
  }

  if (metric === 'hr') {
    const present = hr.filter(isNumber)
    const floors = zoneFloorsBpm(hrMax)
    return {
      // Never the bpm — the number drifts with heat, sleep and the strap, and no decision
      // in the plan is made on it.
      value: activity.averageHeartrate == null ? '—' : zoneTag(hrZone(activity.averageHeartrate, hrMax)),
      unit: 'de media',
      span: range(hr, (v) => zoneTag(hrZone(v, hrMax))),
      legend: 'umbrales Z2 a Z5',
      chart: (
        <LineChart
          label="Pulso a lo largo de la distancia, por zonas, con la altitud de fondo"
          steps={steps}
          height={132}
          backdrop={altitude}
          series={[{ values: hr, className: 'stroke-red', areaClassName: 'fill-red/10' }]}
          // No `baseline`: the floor here is "five under the lowest beat", not a zero.
          yMin={Math.min(...present) - 5}
          yMax={Math.max(...present) + 5}
          rules={([2, 3, 4, 5] as const).map((zone) => ({ at: floors[zone] }))}
        />
      ),
    }
  }

  const present = cadence.filter(isNumber)
  return {
    value: activity.cadenceSpm == null ? '—' : String(activity.cadenceSpm),
    unit: 'pasos/min de media',
    span: range(cadence, String),
    legend: 'objetivo 170 pasos/min',
    chart: (
      <LineChart
        label="Cadencia a lo largo de la distancia, con la altitud de fondo"
        steps={steps}
        height={132}
        backdrop={altitude}
        series={[{ values: cadence, className: 'stroke-blue' }]}
        yMin={Math.min(...present) - 5}
        yMax={Math.max(...present) + 5}
        rules={[{ at: 170, className: 'stroke-accent/60' }]}
      />
    ),
  }
}

const isNumber = (v: number | null | undefined): v is number => v != null

/** `3:52 – 5:10`: the quick and the slow end of a trace, for the corner of its card. */
function range(values: (number | null)[], fmt: (v: number) => string): string {
  const present = values.filter(isNumber)
  if (present.length === 0) return ''
  const lo = fmt(Math.min(...present))
  const hi = fmt(Math.max(...present))
  // A run held inside one zone reads `Z3`, not `Z3 – Z3`.
  return lo === hi ? lo : `${lo} – ${hi}`
}

// ---------------------------------------------------------------------------
// Loading
//
// Two shapes, because the screen has two waits: the block payload (everything) and the
// detail request (everything below the summary). Each skeleton is the geometry of the
// card it stands in for — a wrong shape is worse than none, since the card then visibly
// rearranges itself the moment the data lands.
//
// No `fade-up` on any of them: the skeleton already breathes, and the real card fades up
// as it replaces it. Two reveals over the same pixels inside half a second is a flicker.
// Each wait announces itself once — the card that leads it carries the `aria-busy`, and
// the cards behind it are `aria-hidden` rather than three announcements of one wait.
// ---------------------------------------------------------------------------

function ScreenSkeleton() {
  return (
    <>
      <Card aria-busy="true" aria-label="Cargando la actividad">
        <Skeleton className="h-3 w-20" />
        <Skeleton className="mt-3 h-4 w-44" />
        <Skeleton className="mt-2 h-3 w-36" />
        <div className="mt-3 flex items-center justify-between gap-3">
          <Skeleton className="h-8 w-28" />
          <Skeleton className="h-7 w-24" />
        </div>
        <Skeleton className="mt-2.5 h-3 w-40" />
        <div className="mt-3 grid grid-cols-2 gap-x-3 gap-y-3 border-t border-line pt-3">
          {Array.from({ length: 4 }, (_, i) => (
            <div key={i}>
              <Skeleton className="h-2.5 w-14" />
              <Skeleton className="mt-1.5 h-4 w-12" />
            </div>
          ))}
        </div>
      </Card>
      <TraceSkeleton />
    </>
  )
}

function TraceSkeleton() {
  return (
    <>
      <Card aria-busy="true" aria-label="Cargando la traza del reloj">
        <Skeleton className="h-11 w-full rounded-xl" />
        <div className="mt-3 flex items-baseline justify-between">
          <Skeleton className="h-5 w-32" />
          <Skeleton className="h-3 w-24" />
        </div>
        <Skeleton className="mt-3 h-[132px] w-full rounded-xl" />
        <div className="mt-2 flex items-baseline justify-between">
          <Skeleton className="h-2.5 w-8" />
          <Skeleton className="h-2.5 w-14" />
        </div>
      </Card>
      <Card aria-hidden>
        <Skeleton className="h-2.5 w-28" />
        <Skeleton className="mt-2.5 h-2.5 w-full rounded-full" />
        <div className="mt-3 grid grid-cols-5 gap-1">
          {Array.from({ length: 5 }, (_, i) => (
            <div key={i}>
              <Skeleton className="h-2.5 w-5" />
              <Skeleton className="mt-1.5 h-2.5 w-10" />
            </div>
          ))}
        </div>
      </Card>
    </>
  )
}

// ---------------------------------------------------------------------------
// Zones and splits
// ---------------------------------------------------------------------------

/**
 * Where the pulse actually sat, as one bar and its key.
 *
 * Five columns rather than a `StatStrip`: the strip's ceiling is four because a fifth
 * column stops fitting a label *and* a number, and here the label is two characters. The
 * bar is the reading and the key is the scale, so both stay whole — and a zone with no
 * time in it is dimmed rather than dropped, since removing one would slide the other four
 * along and the five zones would stop being a fixed axis.
 */
function Zones({ zoneS }: { zoneS: Record<Zone, number> }) {
  const zones = [1, 2, 3, 4, 5] as const
  const total = zones.reduce((sum, z) => sum + zoneS[z], 0)

  return (
    <Card className="fade-up">
      <CardTitle
        action={
          total > 0 ? (
            <span className="text-caption tabular-nums text-label-3">
              {formatDuration(total)} con pulso
            </span>
          ) : undefined
        }
      >
        Tiempo por zona
      </CardTitle>

      {/* The bar draws its own empty track and this sentence when there is no pulse, so a
          run without a strap says why the card is flat instead of quietly disappearing. */}
      <StackedBar
        parts={zones.map((z) => ({ key: z, value: zoneS[z], className: ZONE_ACCENT[z].bar }))}
        // The five zones are spelled out with their times right under the bar, so this
        // names the shape and sends the reader there rather than repeating them.
        label="Reparto del tiempo de esta salida por zonas de pulso. El detalle, zona a zona, está debajo."
        emptyLabel="Esta salida no lleva pulso, así que no hay reparto por zonas."
      />

      {total > 0 ? (
        <ul className="mt-3 grid grid-cols-5 gap-1">
          {zones.map((z) => (
            <li key={z} className={zoneS[z] > 0 ? undefined : 'opacity-45'}>
              <span className={cn('block text-caption font-semibold', ZONE_ACCENT[z].text)}>
                {zoneTag(z)}
              </span>
              <span className="block text-caption tabular-nums text-label-2">
                {formatDuration(zoneS[z])}
              </span>
              <span className="block text-caption2 tabular-nums text-label-3">
                {decimal((zoneS[z] / total) * 100, 0)} %
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </Card>
  )
}

/**
 * The numbers under the trace: one row per split, or one per lap on a day the athlete
 * pressed the button — with the shape of those numbers drawn compactly above them.
 *
 * A table rather than a list of rows, because every column here is a comparison down the
 * page — the fourth rep against the first, the kilometre the hill was on. The fastest one
 * is called out in accent, and its pace is repeated in the card's header so the colour is
 * never the only thing saying which row won; a screen reader gets the same fact said in
 * words on the row itself.
 *
 * The bars above are the same numbers as a shape, with the climb showing through behind
 * them. They carry no labels of their own: the table under them prints every number they
 * could, and a 375px card cannot afford to say anything twice. See `SplitBars` for why
 * their scale does not start at zero.
 */
function SplitTable<T extends Split>({
  title,
  rows,
  labelFor,
  backdrop,
  hrMax,
}: {
  title: string
  rows: T[]
  labelFor: (row: T, index: number) => string
  /** The altitude profile from the trace, on the same distance axis as the splits. */
  backdrop?: (number | null)[]
  hrMax: number
}) {
  // Anything under 200 m is the tail of a run, not a split worth winning — and with no
  // measured row at all, `Math.min()` is `Infinity`, so the fastest is `null` rather than
  // a number the table would then try to match.
  const measured = rows.filter((r) => r.distanceM >= 200 && r.paceSKm > 0)
  const fastest = measured.length > 0 ? Math.min(...measured.map((r) => r.paceSKm)) : null
  const slowest = measured.length > 0 ? Math.max(...measured.map((r) => r.paceSKm)) : null
  const hasHr = rows.some((r) => r.heartrate != null)

  const bars = rows.map((row, i) => {
    const zone = row.heartrate == null ? null : hrZone(row.heartrate, hrMax)
    return {
      key: i,
      // Speed, not pace: the bar has to be *taller* for a faster split, and pace runs the
      // other way. Dividing here keeps `SplitBars` ignorant of what it is drawing.
      value: row.paceSKm > 0 ? 1000 / row.paceSKm : 0,
      className: zone ? ZONE_ACCENT[zone].bar : undefined,
      title: `${labelFor(row, i)}: ${row.paceSKm > 0 ? formatPace(row.paceSKm) : '—'}`,
    }
  })

  return (
    <Card className="fade-up">
      {/* Naming the fastest split in the header is what keeps the accent row from being
          colour on its own: the number up here is the one highlighted down there. */}
      <CardTitle
        action={
          fastest == null ? undefined : (
            <span className="text-caption tabular-nums text-label-3">
              más rápido {formatPace(fastest)}
            </span>
          )
        }
      >
        {title}
      </CardTitle>

      <SplitBars
        bars={bars}
        backdrop={backdrop}
        className="mb-1"
        label={`${title}, ${rows.length} tramos: la altura de cada barra es su ritmo, entre ${
          slowest == null ? '—' : formatPace(slowest)
        } y ${fastest == null ? '—' : formatPace(fastest)} por kilómetro. Los números están en la tabla siguiente.`}
      />
      <p className="mb-2 text-caption2 leading-relaxed text-label-3">
        {fastest != null && slowest != null && fastest !== slowest
          ? `Altura: ritmo de ${formatPace(slowest)} a ${formatPace(fastest)}; no empieza en cero. Al fondo, la altitud.`
          : 'Altura: el ritmo de cada tramo; no empieza en cero. Al fondo, la altitud.'}
      </p>

      <table className="w-full text-footnote tabular-nums">
        <thead className="text-caption2 uppercase tracking-[0.12em] text-label-3">
          <tr>
            <th className="pb-1 text-left font-medium">#</th>
            <th className="pb-1 text-right font-medium">km</th>
            <th className="pb-1 text-right font-medium">Ritmo</th>
            {hasHr ? <th className="pb-1 text-right font-medium">Zona</th> : null}
            <th className="pb-1 text-right font-medium">Desn.</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => {
            const zone = row.heartrate == null ? null : hrZone(row.heartrate, hrMax)
            const best = fastest != null && row.paceSKm === fastest
            const climb = row.elevationM == null ? null : Math.round(row.elevationM)

            return (
              <tr key={i} className="border-t border-line">
                <td className="py-1.5 text-left text-label-3">{labelFor(row, i)}</td>
                <td className="py-1.5 text-right text-label-2">{formatKm(row.distanceM)}</td>
                <td className={cn('py-1.5 text-right', best ? 'font-semibold text-accent' : 'text-label')}>
                  {row.paceSKm > 0 ? formatPace(row.paceSKm) : '—'}
                  {best ? <span className="sr-only"> (el más rápido)</span> : null}
                </td>
                {hasHr ? (
                  <td className={cn('py-1.5 text-right', zone ? ZONE_ACCENT[zone].text : 'text-label-3')}>
                    {zone ? zoneTag(zone) : '—'}
                  </td>
                ) : null}
                <td className="py-1.5 text-right text-label-3">
                  {climb == null ? '—' : `${climb > 0 ? '+' : ''}${decimal(climb, 0)}`}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </Card>
  )
}

/**
 * The screen as the page mounts it: wrapped so a render that throws leaves a card with a
 * way out on it rather than an empty column under the heading. See `Island.tsx`.
 */
export const ActivityDetail = island(ActivityDetailScreen)
