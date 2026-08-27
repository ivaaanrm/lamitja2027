import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { formatDuration, formatKm, formatPace, formatPaceRange, isRun, paceSKm } from '@/lib/activity'
import { goalPaceSKm, totalWeeks, type BlockConfig } from '@/lib/block'
import { cn } from '@/lib/cn'
import type { Activity, PlanSession } from '@/lib/db/schema'
import { decimal } from '@/lib/format'
import { DEFAULT_HR_MAX, PACE_ZONE_NUMBER, hrZone, paceBands, zoneTag } from '@/lib/paces'
import { setDone } from '@/lib/plan-client'
import { SESSION_META, sessionEffort, type MatchedSession, type SessionType, type WeekPlan } from '@/lib/plan'
import {
  BY_FEEL,
  STEP_ROLE,
  formatDistance,
  formatRecovery,
  hardDistanceM,
  isEffort,
  paceBandLabel,
  stepAmount,
  stepHeadline,
  workoutDistanceM,
  workoutDurationS,
  zoneLabel,
  type Bands,
  type Step,
} from '@/lib/workout'
import { NoBlockCard, useBlock } from './useBlock'
import { island } from './Island'
import {
  ACCENT,
  ARROW_OUT,
  CHEVRON_LEFT,
  Card,
  CardTitle,
  Chip,
  EmptyState,
  ErrorCard,
  HeroMetric,
  Icon,
  LoadingCard,
  Skeleton,
  Stat,
  StatStrip,
  TextLink,
  TypeChip,
  ZoneChip,
} from './ui'

/**
 * One prescribed session, spelled out — the screen you read the night before, not the row
 * you scan on the way past.
 *
 * `SessionCard` is a row in a week and is priced like one: it answers "what is this and
 * has it happened" in 72px, and unfolds a summary of the workout under it. That is the
 * right density for a list and the wrong one for the session you are about to go and run,
 * where the questions are "how many, how far, how fast, and how long do I jog between
 * them" — four answers per step, which is four lines a week of cards cannot afford.
 *
 * So the step list here is the same `Step[]` at a different resolution: one block per step
 * with its amount set large, a repeat header over the sets (`× 5`, the way a workout is
 * actually written on a whiteboard) and the recovery as its own row inside the block it
 * belongs to. Everything is derived from the steps — the total distance, the estimated
 * time on feet, the kilometres at threshold or faster — because they are derived
 * everywhere else in the app too, and a second copy of a number is a second copy to keep
 * honest.
 *
 * No fetch of its own: `/api/data` already carries the whole block, so this screen is a
 * lookup in the payload the tab it was opened from was already rendered with. The id and
 * the way back are in the query string and read in an effect, because the island is also
 * rendered at build time in a Worker with no `location` (AGENTS gotcha 15).
 */
function SessionDetailScreen() {
  const { data, weeks, error, reload } = useBlock()
  // `undefined` is "the query string has not been read yet" and `null` is "there is no id
  // in it" — collapsing the two would flash the dead-end card on every first paint.
  const [id, setId] = useState<string | null | undefined>(undefined)
  const [origin, setOrigin] = useState<'hoy' | 'plan'>('plan')
  const [saving, setSaving] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)

  useEffect(() => {
    const params = new URLSearchParams(location.search)
    setId(params.get('id'))
    setOrigin(params.get('desde') === 'hoy' ? 'hoy' : 'plan')
  }, [])

  const found = useMemo(() => {
    if (!id) return null
    for (const week of weeks) {
      const match = week.sessions.find((m) => m.session.id === id)
      if (match) return { match, week }
    }
    return null
  }, [weeks, id])

  const back = origin === 'hoy' ? { href: '/', label: 'Hoy' } : { href: '/plan', label: 'Plan' }

  if (error && !data)
    return <ErrorCard title="Sin datos del bloque" message={error} onRetry={() => void reload()} />
  if (!data || id === undefined) return <ScreenSkeleton />
  // No dates yet — `/bienvenida` is the only thing that fixes it, and every number on
  // this screen is counted from them.
  if (!data.block) return <NoBlockCard />

  const block = data.block
  const hrMax = data.user.hrMax ?? DEFAULT_HR_MAX
  // A zone is a share of *this* athlete's goal pace — see the same line in `Planner`.
  const bands = paceBands(goalPaceSKm(block))

  if (!found) {
    return (
      <Card className="fade-up">
        <CardTitle>Sesión</CardTitle>
        <EmptyState action={<TextLink href={back.href}>Volver a {back.label}</TextLink>}>
          {id
            ? 'Esa sesión ya no está en el plan. Puede que la hayas borrado o que el plan se haya vuelto a sembrar desde entonces.'
            : 'La dirección no dice qué sesión abrir. Vuelve al plan y toca una.'}
        </EmptyState>
      </Card>
    )
  }

  const { match, week } = found
  const { session, activity, done } = match
  const steps = session.steps?.length ? session.steps : null
  // Only the sessions Strava will never report are ticked by hand; a matched activity has
  // already settled the question, and a rest day was never owed.
  const toggle =
    activity || session.type === 'rest'
      ? null
      : async () => {
          setActionError(null)
          setSaving(true)
          try {
            await setDone(session.id, !done)
            await reload()
          } catch (cause) {
            setActionError(cause instanceof Error ? cause.message : 'No se pudo guardar')
          } finally {
            setSaving(false)
          }
        }

  return (
    <>
      <Overview block={block} match={match} week={week} back={back} bands={bands} />

      {SESSION_META[session.type].family === 'run' ? (
        steps ? (
          <Workout steps={steps} type={session.type} bands={bands} />
        ) : (
          <Card className="fade-up">
            <CardTitle>El entrenamiento</CardTitle>
            <EmptyState
              action={
                <TextLink href="/plan" tone="primary">
                  Desglosarla en el plan
                </TextLink>
              }
            >
              Esta sesión está escrita como una distancia y nada más — sin calentamiento,
              series ni vuelta a la calma —, así que no hay nada que desglosar paso a paso.
            </EmptyState>
          </Card>
        )
      ) : null}

      {session.notes ? (
        <Card className="fade-up">
          <CardTitle>Cómo correrla</CardTitle>
          <p className="whitespace-pre-line text-footnote leading-relaxed text-label-2">
            {session.notes}
          </p>
        </Card>
      ) : null}

      {activity ? <Result activity={activity} session={session} hrMax={hrMax} /> : null}

      {/* Not a card, and not a filled button. The two actions a session detail offers are
          both secondary to reading it — one of them only exists for the sessions Strava
          will never report — and a mint slab across the foot of the screen made the last
          thing on it the loudest. A pair of text actions on the page ground weighs what
          they are worth and still holds a 44px target each. */}
      <div className="flex flex-wrap items-center justify-between gap-x-4 px-1">
        {toggle ? (
          // Mint on the word rather than behind it: still the affirmative action, at the
          // weight of one.
          <TextLink
            tone={done ? 'quiet' : 'primary'}
            disabled={saving}
            inset
            className="-ml-2"
            onClick={() => void toggle()}
          >
            {done ? 'Marcar como pendiente' : 'Marcar como hecha'}
          </TextLink>
        ) : session.type === 'rest' ? (
          <span />
        ) : (
          <p className="text-caption leading-relaxed text-label-3">
            Se marca sola en cuanto Strava reporte la salida.
          </p>
        )}
        <TextLink href="/plan" inset className="-mr-2">
          Editar en el plan
        </TextLink>
      </div>
      {actionError ? (
        <p role="alert" className="px-1 text-caption text-red">
          {actionError}
        </p>
      ) : null}
    </>
  )
}

const dateFmt = new Intl.DateTimeFormat('es-ES', {
  weekday: 'long',
  day: 'numeric',
  month: 'long',
  // Dates are UTC midnight of the local day; formatting in the viewer's zone slides them.
  timeZone: 'UTC',
})

/**
 * What the session is and what it asks for, before a single step is read.
 *
 * The hero is the prescription — the distance, or the minutes for the sessions that carry
 * no distance at all — and the line under it is the effort: `Z4 · Umbral · 3:50–3:58/km ·
 * ≈ 52m`, or `A sensaciones` where the plan deliberately prescribes no band. Those are the
 * two facts that decide whether you go out now or after breakfast, so they are the two the
 * screen opens with; everything below is how the session is built.
 */
function Overview({
  block,
  match,
  week,
  back,
  bands,
}: {
  block: BlockConfig
  match: MatchedSession
  week: WeekPlan
  back: { href: string; label: string }
  bands: Bands
}) {
  const { session, activity, done } = match
  const effort = sessionEffort(session, bands)
  const pace = effort.band ? formatPaceRange(effort.band.lo, effort.band.hi) : null
  // The zone names the band; without one the honest answer is the plan's own words, and
  // with a hand-typed pace there is no zone to name — the number says it all.
  const intensity = effort.zone ? zoneLabel(effort.zone) : pace ? null : BY_FEEL
  const context = [
    intensity,
    pace,
    effort.estimateS ? `≈ ${formatDuration(effort.estimateS)}` : null,
  ]
    .filter(Boolean)
    .join(' · ')

  const minutes = session.targetDurationS == null ? null : Math.round(session.targetDurationS / 60)

  return (
    <Card className="fade-up">
      <div className="-mx-1 -mt-1.5 flex items-center justify-between gap-2">
        <a
          href={back.href}
          className="tappable inline-flex min-h-11 items-center gap-1 px-1 text-caption font-medium text-label-2"
        >
          <Icon path={CHEVRON_LEFT} className="size-3.5" />
          {back.label}
        </a>
        {activity ? (
          // The trace is a screen of its own and it is the natural next tap once a session
          // has been answered, so it sits with the navigation rather than buried under the
          // result card below.
          <a
            href={`/actividad?id=${activity.id}`}
            className="tappable inline-flex min-h-11 items-center gap-1 px-1 text-caption font-medium text-label-2"
          >
            Ver la traza
            <Icon path={ARROW_OUT} className="size-3.5" />
          </a>
        ) : null}
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        <TypeChip type={session.type} />
        {done ? <Chip tone="done">Hecha</Chip> : null}
      </div>
      <h2 className="mt-1.5 font-display text-title3 font-bold leading-tight tracking-tight text-label">
        {session.title}
      </h2>
      <p className="mt-1 text-footnote text-label-2 first-letter:uppercase">
        {dateFmt.format(new Date(session.scheduledOn))}
      </p>
      <p className="mt-0.5 text-caption tabular-nums text-label-3">
        {[`Semana ${week.weekIndex + 1} de ${totalWeeks(block)}`, week.week?.phase]
          .filter(Boolean)
          .join(' · ')}
      </p>

      {session.targetDistanceM != null ? (
        <HeroMetric
          className="mt-3"
          value={decimal(session.targetDistanceM / 1000)}
          unit="km previstos"
          context={context || undefined}
        />
      ) : minutes != null ? (
        <HeroMetric className="mt-3" value={minutes} unit="min previstos" />
      ) : null}
    </Card>
  )
}

/**
 * The workout as a timeline: one node per step, down one rail, in the order it is run.
 *
 * A session is a sequence in time before it is a list of prescriptions, and boxing each
 * step made it read as a form — five framed panels stacked, each with its own internal
 * rules, which is three levels of enclosure inside a card that is already one. The rail
 * says the same thing with a hairline: these happen in this order, and there is nothing
 * between them.
 *
 * Two lines per node and no more. The amount is the figure the eye comes back to mid-rep,
 * so it is set at `subhead` and carries the repetition beside it as a badge in the
 * session's hue — `2 km ×4`, the way a set is written on a whiteboard, rather than folded
 * into the sentence. Under it, quietly, the role and the band. The recovery hangs off the
 * set it belongs to as a third line, because a jog is not a step of its own: it is part of
 * how the set is run, and giving it a node of its own doubles the length of every interval
 * session on the screen.
 *
 * The footer is the three totals the steps already answer. `workoutDistanceM` counts the
 * recovery jogs, which is why it is larger than the reps add up to, and `hardDistanceM`
 * counts only what is run at threshold or faster — the honest measure of the session and
 * the one docs/03 §3 budgets the week in.
 */
function Workout({ steps, type, bands }: { steps: Step[]; type: SessionType; bands: Bands }) {
  const hard = hardDistanceM(steps, bands)
  const totals = [
    formatDistance(workoutDistanceM(steps, bands)),
    `≈ ${formatDuration(workoutDurationS(steps, bands))}`,
    hard > 0 ? `${formatDistance(hard)} a umbral o más` : null,
  ]
    .filter(Boolean)
    .join(' · ')

  return (
    <Card className="fade-up">
      <CardTitle>El entrenamiento</CardTitle>
      <ol>
        {steps.map((step, i) => (
          <TimelineStep
            key={i}
            step={step}
            type={type}
            bands={bands}
            last={i === steps.length - 1}
          />
        ))}
      </ol>
      <p className="mt-1 border-t border-line pt-2 text-caption tabular-nums text-label-3">
        <span className="text-label-2">Total</span> {totals}
      </p>
    </Card>
  )
}

function TimelineStep({
  step,
  type,
  bands,
  last,
}: {
  step: Step
  type: SessionType
  bands: Bands
  /** The last node draws no connector — a rail past the final step is a step that is missing. */
  last: boolean
}) {
  const accent = ACCENT[type]
  const zone = step.zone ? PACE_ZONE_NUMBER[step.zone] : null
  const effort = isEffort(step)
  const sub = [STEP_ROLE[step.kind], paceBandLabel(step.zone, bands)].filter(Boolean).join(' · ')

  return (
    <li className="flex gap-2.5 pb-3.5 last:pb-0">
      {/* The marker column stretches with the row, so the connector is `flex-1` rather
          than a height anyone has to compute from the content above it. */}
      <span aria-hidden className="flex w-2 shrink-0 flex-col items-center">
        <span
          className={cn(
            'mt-1.5 size-2 shrink-0 rounded-full',
            // Filled in the session's hue for the running that *is* the workout, hollow
            // for the running that brackets it: the shape says which is which before the
            // colour does, and a warm-up in full accent reads as another rep.
            effort && step.zone ? accent.dot : 'border border-line-strong',
          )}
        />
        {last ? null : <span className="mt-1 w-px flex-1 bg-line" />}
      </span>

      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-2">
          <span className="flex min-w-0 items-baseline gap-1.5">
            <span className="data-number text-subhead font-semibold text-label">
              {stepAmount(step) || stepHeadline(step)}
            </span>
            {step.reps > 1 ? (
              <span
                className={cn(
                  'data-number shrink-0 rounded-md px-1 py-px text-caption2 font-semibold ring-1 ring-inset',
                  accent.chip,
                )}
              >
                ×{step.reps}
              </span>
            ) : null}
          </span>
          {zone ? <ZoneChip zone={zone} /> : null}
        </div>

        {sub ? <p className="mt-0.5 text-caption tabular-nums text-label-3">{sub}</p> : null}

        {step.recovery && step.reps > 1 ? (
          <p className="mt-1 text-caption tabular-nums text-label-2">
            {formatRecovery(step.recovery)} entre series
          </p>
        ) : null}

        {step.note ? (
          <p className="mt-1 text-caption leading-relaxed text-label-3">{step.note}</p>
        ) : null}
      </div>
    </li>
  )
}

/**
 * What answered the session, as the three numbers the plan asked for measured back.
 *
 * The distance carries its target as a hint rather than as a second column, which is what
 * makes the comparison readable without arithmetic: `12,4 km` over `de 12,0 previstos`.
 * Cadence and the heart-rate zone hang under the rule — the two secondary markers the knee
 * protocol is steered by, and the zone rather than the bpm for the reason it always is.
 */
function Result({
  activity,
  session,
  hrMax,
}: {
  activity: Activity
  session: PlanSession
  hrMax: number
}) {
  const pace = isRun(activity.sportType) ? paceSKm(activity.distanceM, activity.movingS) : null
  const markers: { key: string; node: ReactNode }[] = []
  if (activity.cadenceSpm) {
    markers.push({
      key: 'cadence',
      node: (
        <span className={activity.cadenceSpm >= 170 ? 'text-mint' : 'text-amber'}>
          {activity.cadenceSpm} pasos/min
        </span>
      ),
    })
  }
  if (activity.averageHeartrate) {
    markers.push({
      key: 'hr',
      node: <span>{zoneTag(hrZone(activity.averageHeartrate, hrMax))} de media</span>,
    })
  }

  return (
    <Card className="fade-up">
      <CardTitle>Lo que hiciste</CardTitle>
      <StatStrip>
        <Stat
          label="Distancia"
          value={`${formatKm(activity.distanceM)} km`}
          hint={
            session.targetDistanceM != null
              ? `de ${formatKm(session.targetDistanceM)} previstos`
              : undefined
          }
        />
        <Stat label="Tiempo" value={formatDuration(activity.movingS)} />
        {pace ? <Stat label="Ritmo" value={formatPace(pace)} hint="min/km" /> : null}
      </StatStrip>
      {markers.length > 0 ? (
        <p className="mt-2 flex flex-wrap gap-x-2 gap-y-0.5 border-t border-line pt-2 text-caption tabular-nums text-label-3">
          {markers.map((marker) => (
            <span key={marker.key}>{marker.node}</span>
          ))}
        </p>
      ) : null}
    </Card>
  )
}

/**
 * The shape of the screen that is coming: the overview card, then the workout.
 *
 * The block payload is usually already in module scope by the time this island mounts —
 * every route into here is a tab that has read it — so this is the cold-load state, and it
 * stands in the shape of what replaces it rather than announcing itself as a wait.
 */
function ScreenSkeleton() {
  return (
    <>
      <LoadingCard rows={2} />
      <Card aria-hidden>
        <Skeleton className="h-2.5 w-28" />
        <div className="mt-2 space-y-1.5">
          {Array.from({ length: 3 }, (_, i) => (
            <Skeleton key={i} className="h-14 w-full rounded-xl" />
          ))}
        </div>
      </Card>
    </>
  )
}

/**
 * The screen as the page mounts it: wrapped so a render that throws leaves a card with a
 * way out on it rather than an empty column under the heading. See `Island.tsx`.
 */
export const SessionDetail = island(SessionDetailScreen)
