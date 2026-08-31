import { useMemo, useState, type ReactNode } from 'react'
import { formatDuration, formatKm, formatPace, formatPaceRange, isRun, paceSKm } from '@/lib/activity'
import { goalPaceSKm, totalWeeks, type BlockConfig } from '@/lib/block'
import type { Activity, PlanSession } from '@/lib/db/schema'
import { decimal } from '@/lib/format'
import { DEFAULT_HR_MAX, hrZone, paceBands, zoneTag } from '@/lib/paces'
import { setDone } from '@/lib/plan-client'
import { SESSION_META, sessionEffort, type MatchedSession, type WeekPlan } from '@/lib/plan'
import { prescriptionOf } from '@/lib/prescription'
import { BY_FEEL, zoneLabel, type Bands } from '@/lib/workout'
import { PrescriptionDetail, PrescriptionEmpty } from './prescription-views'
import { NoBlockCard, useBlock } from './useBlock'
import { island } from './Island'
import { useRouteParams, type Route } from './router'
import {
  ARROW_OUT,
  CHECK,
  CHEVRON_LEFT,
  PENCIL,
  UNDO,
  ActionLink,
  Card,
  CardTitle,
  Chip,
  EmptyState,
  ErrorCard,
  HeroMetric,
  LoadingCard,
  Skeleton,
  Stat,
  StatStrip,
  TextLink,
  TypeChip,
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
 * the way back are in the query string, read off the route rather than off `location`:
 * `/sesion` is one prerendered shell for every session, so during hydration the only
 * honest answer is the one the markup was built with — no id at all. `useRouteParams`
 * returns `null` for exactly that render and the real params for every one after, which
 * on a hop from inside the app is the *first* one. See `router.tsx`.
 */
function SessionDetailScreen({ route }: { route: Route }) {
  const { data, weeks, error, reload } = useBlock()
  // `undefined` is "the query string has not been read yet" and `null` is "there is no id
  // in it" — collapsing the two would flash the dead-end card on every first paint.
  const params = useRouteParams(route)
  const id: string | null | undefined = params ? params.get('id') : undefined
  const origin = params?.get('desde') === 'hoy' ? 'hoy' : 'plan'
  const [saving, setSaving] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)

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
  const prescription = prescriptionOf(session.steps)
  /** Whether this *kind* of session is supposed to carry one — a rest day never is. */
  const prescribes = SESSION_META[session.type].prescribes
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

      {/* The prescription draws itself, whatever kind it is — a timeline of steps for a
          run, a checklist of moves for a Fuerza day — and so does its *absence*, which is
          worded per kind because the fix is different for each and the copy lives with the
          kind rather than in an `else` here. A `rest` day prescribes nothing and gets
          neither. */}
      {prescription ? (
        <PrescriptionDetail p={prescription} type={session.type} bands={bands} />
      ) : prescribes ? (
        <PrescriptionEmpty kind={prescribes} />
      ) : null}

      {session.notes ? (
        <Card className="fade-up">
          {/* A Fuerza day is not run, and a card telling you how to run it is the app
              still assuming every session has a pace. */}
          <CardTitle>
            {SESSION_META[session.type].family === 'run' ? 'Cómo correrla' : 'Cómo hacerla'}
          </CardTitle>
          <p className="whitespace-pre-line text-footnote leading-relaxed text-label-2">
            {session.notes}
          </p>
        </Card>
      ) : null}

      {activity ? <Result activity={activity} session={session} hrMax={hrMax} /> : null}

      {/* Not a card, and not a filled button. The two actions a session detail offers are
          both secondary to reading it — one of them only exists for the sessions Strava
          will never report — and a accent slab across the foot of the screen made the last
          thing on it the loudest. A pair of glyph-led actions on the page ground weighs
          what they are worth and still holds a 44px target each — and they are the same
          shape as the two at the head of the screen, so every tappable word on `/sesion`
          is a glyph and a label rather than three different ideas of an action. */}
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 px-1">
        {toggle ? (
          // The tick is the app's own word for done — the same glyph `DoneToggle` draws in
          // every week row — so ticking it off here is spelled the way it is spelled there,
          // and the undo arrow is what takes it back.
          <ActionLink
            icon={done ? UNDO : CHECK}
            tone={done ? 'quiet' : 'primary'}
            disabled={saving}
            inset
            className="-ml-1"
            onClick={() => void toggle()}
          >
            {done ? 'Marcar como pendiente' : 'Marcar como hecha'}
          </ActionLink>
        ) : session.type === 'rest' ? (
          <span />
        ) : (
          <p className="text-caption leading-relaxed text-label-3">
            Se marca sola en cuanto Strava reporte la salida.
          </p>
        )}
        <ActionLink icon={PENCIL} href="/plan" inset className="-mr-1">
          Editar en el plan
        </ActionLink>
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
        <ActionLink icon={CHEVRON_LEFT} href={back.href}>
          {back.label}
        </ActionLink>
        {activity ? (
          // The trace is a screen of its own and it is the natural next tap once a session
          // has been answered, so it sits with the navigation rather than buried under the
          // result card below.
          <ActionLink icon={ARROW_OUT} after href={`/actividad?id=${activity.id}`}>
            Ver la traza
          </ActionLink>
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
        <span className={activity.cadenceSpm >= 170 ? 'text-accent' : 'text-amber'}>
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
