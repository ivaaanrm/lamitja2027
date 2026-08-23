import { useState } from 'react'
import { formatDuration, formatKm, formatPace, formatPaceRange, isRun, paceSKm } from '@/lib/activity'
import { cn } from '@/lib/cn'
import { hrZone, zoneTag } from '@/lib/paces'
import { SESSION_META, type MatchedSession } from '@/lib/plan'
import {
  formatRecovery,
  formatWorkout,
  isEffort,
  paceBandLabel,
  stepHeadline,
  workoutDurationS,
  type Step,
} from '@/lib/workout'
import { ACCENT, DoneToggle, TypeChip } from './ui'

/**
 * One prescribed session: what it asks for, and what answered it.
 *
 * The prescription is the point, so the repetitions are on the face of the card rather
 * than behind a tap — "5 × 1 km @ 3:30–3:40/km · 90 s jog" is what you read on the way
 * out of the door. Tapping opens the step-by-step breakdown and the coaching note.
 */
export function SessionCard({
  match,
  onToggle,
  onEdit,
  defaultOpen = false,
}: {
  match: MatchedSession
  /** Absent for sessions a Strava activity already settled — there is nothing to tick. */
  onToggle?: () => void
  onEdit?: () => void
  defaultOpen?: boolean
}) {
  const [open, setOpen] = useState(defaultOpen)
  const { session, activity, done } = match
  const meta = SESSION_META[session.type]
  const accent = ACCENT[session.type]

  const steps = session.steps ?? null
  const paces = formatPaceRange(session.targetPaceLoSKm, session.targetPaceHiSKm)
  // Strength and cycling are prescribed in minutes; everything that runs, in kilometres.
  const target =
    session.targetDistanceM != null
      ? `${formatKm(session.targetDistanceM)} km`
      : session.targetDurationS != null
        ? formatDuration(session.targetDurationS)
        : null
  // Estimated, never stored — a distance costed at the mid-point of its own pace band.
  const estimate =
    steps && session.targetDistanceM != null ? formatDuration(workoutDurationS(steps)) : null

  // A single step says nothing the header has not already said — "4 km @ 5:00–5:30/km"
  // under a card that reads "4.0 km · 5:00–5:30/km" is the same sentence twice.
  const detailed = steps != null && steps.length > 1
  const expandable = Boolean(detailed || session.notes || onEdit)

  return (
    <article
      className={cn(
        'relative overflow-hidden rounded-xl bg-surface-raised transition-colors',
        done && 'bg-surface-raised/60',
      )}
    >
      <span aria-hidden className={cn('absolute inset-y-0 left-0 w-1', accent.rail, done && 'opacity-40')} />

      <div className="py-3 pl-4 pr-3">
        <div className="flex items-start gap-2.5">
          {session.type === 'rest' ? (
            <span aria-hidden className="mt-0.5 size-6" />
          ) : (
            <DoneToggle done={done} label={session.title} onToggle={onToggle} />
          )}

          <button
            type="button"
            onClick={() => expandable && setOpen(!open)}
            aria-expanded={expandable ? open : undefined}
            disabled={!expandable}
            className="flex min-w-0 flex-1 items-start justify-between gap-3 text-left disabled:cursor-default"
          >
            <span className="min-w-0">
              <span className="flex flex-wrap items-center gap-1.5">
                <TypeChip type={session.type} />
                <span className={cn('text-sm font-medium', done && 'text-label-2')}>
                  {session.title}
                </span>
              </span>

              {paces || estimate ? (
                <span className="mt-0.5 block text-xs tabular-nums text-label-3">
                  {[paces, estimate && `≈ ${estimate}`].filter(Boolean).join(' · ')}
                </span>
              ) : null}
            </span>

            <span className="flex shrink-0 items-center gap-1.5">
              {target ? (
                <span className="text-sm font-semibold tabular-nums text-label">{target}</span>
              ) : null}
              {expandable ? <Chevron open={open} /> : null}
            </span>
          </button>
        </div>

        {detailed && !open ? (
          <p className="mt-2 pl-[2.125rem] text-xs leading-relaxed text-label-2">
            {formatWorkout(steps)}
          </p>
        ) : null}

        {/* `expandable` guards the open state as well as the tap: a card opened by default
            with nothing to unfold would otherwise render an empty gap. */}
        {open && expandable ? (
          <div className="mt-3 pl-[2.125rem]">
            {detailed ? <StepList steps={steps} type={session.type} /> : null}
            {session.notes ? (
              <p className="mt-3 border-l-2 border-line pl-3 text-xs leading-relaxed text-label-2">
                {session.notes}
              </p>
            ) : null}
            {onEdit ? (
              <button
                type="button"
                onClick={onEdit}
                className="mt-3 text-xs text-label-2 underline underline-offset-4"
              >
                Editar sesión
              </button>
            ) : null}
          </div>
        ) : null}

        {activity ? <Result activity={activity} session={match.session} /> : null}
      </div>
    </article>
  )
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      aria-hidden
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={cn('size-3 shrink-0 text-label-4 transition-transform', open && 'rotate-90')}
    >
      <path d="m9 18 6-6-6-6" />
    </svg>
  )
}

/** The workout, one step per line, with the recovery hanging off the set it belongs to. */
function StepList({ steps, type }: { steps: Step[]; type: MatchedSession['session']['type'] }) {
  const accent = ACCENT[type]

  return (
    <ol className="space-y-1.5">
      {steps.map((step, i) => (
        <li key={i}>
          <div className="flex items-baseline justify-between gap-3">
            <span className="flex min-w-0 items-baseline gap-2">
              <span
                aria-hidden
                className={cn(
                  'size-1.5 shrink-0 translate-y-[-1px] rounded-full',
                  isEffort(step) && step.zone ? accent.dot : 'bg-fill-strong',
                )}
              />
              <span className={cn('text-xs tabular-nums', isEffort(step) ? 'text-label' : 'text-label-3')}>
                {stepHeadline(step)}
              </span>
            </span>
            <span className="shrink-0 text-xs tabular-nums text-label-3">
              {paceBandLabel(step.zone) ?? ''}
            </span>
          </div>

          {step.recovery && step.reps > 1 ? (
            <p className="ml-3.5 border-l border-line pl-2.5 text-[0.6875rem] text-label-3">
              {formatRecovery(step.recovery)} entre series
            </p>
          ) : null}
          {step.note ? (
            <p className="ml-3.5 pl-2.5 text-[0.6875rem] text-label-3">{step.note}</p>
          ) : null}
        </li>
      ))}
    </ol>
  )
}

/** What actually happened, against what was asked for. */
function Result({
  activity,
  session,
}: {
  activity: NonNullable<MatchedSession['activity']>
  session: MatchedSession['session']
}) {
  const pace = isRun(activity.sportType) ? paceSKm(activity.distanceM, activity.movingS) : null
  const target = session.targetDistanceM
  const delta = target ? (activity.distanceM - target) / 1000 : null

  return (
    <div className="mt-2.5 ml-[2.125rem] flex flex-wrap items-baseline gap-x-3 gap-y-1 rounded-lg bg-mint/10 px-2.5 py-1.5 text-xs tabular-nums ring-1 ring-inset ring-mint/20">
      <span className="font-medium text-mint">{formatKm(activity.distanceM)} km</span>
      {pace ? <span className="text-mint">{formatPace(pace)}/km</span> : null}
      {delta != null && Math.abs(delta) >= 0.2 ? (
        <span className="text-label-3">
          {delta > 0 ? '+' : ''}
          {delta.toFixed(1)} km
        </span>
      ) : null}
      {activity.cadenceSpm ? (
        // docs/03 §6: cadence is the injury fix and the race-form marker, so it is the
        // one secondary number worth carrying on every completed run.
        <span className={cn(activity.cadenceSpm >= 170 ? 'text-mint' : 'text-amber')}>
          {activity.cadenceSpm} pasos/min
        </span>
      ) : null}
      {activity.averageHeartrate ? (
        // The zone, never the number: 151 ppm means nothing without the day's heat, sleep
        // and strap behind it, and no decision in the plan is made on the exact figure.
        <span className="text-label-3">{zoneTag(hrZone(activity.averageHeartrate))}</span>
      ) : null}
    </div>
  )
}

/** A run that answered no prescribed session — shown so a week's total always adds up. */
export function ExtraCard({
  activity,
}: {
  activity: { name: string; distanceM: number; movingS: number; sportType: string }
}) {
  return (
    <article className="relative overflow-hidden rounded-xl bg-surface-raised">
      <span aria-hidden className="absolute inset-y-0 left-0 w-[3px] bg-fill" />
      <div className="flex items-start justify-between gap-3 py-3 pl-4 pr-3">
        <div className="min-w-0">
          <p className="text-[0.625rem] font-semibold uppercase tracking-wider text-label-4">
            Sin planificar
          </p>
          <p className="truncate text-sm text-label-2">{activity.name}</p>
        </div>
        <div className="shrink-0 text-right">
          <p className="text-sm tabular-nums text-label-2">{formatKm(activity.distanceM)} km</p>
          {isRun(activity.sportType) ? (
            <p className="text-xs tabular-nums text-label-3">
              {formatPace(paceSKm(activity.distanceM, activity.movingS))}/km
            </p>
          ) : null}
        </div>
      </div>
    </article>
  )
}
