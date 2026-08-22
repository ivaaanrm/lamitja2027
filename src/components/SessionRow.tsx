import { formatDuration, formatKm, formatPace, formatPaceRange, paceSKm } from '@/lib/activity'
import { SESSION_META, type MatchedSession } from '@/lib/plan'
import { cn } from '@/lib/cn'

/**
 * One prescribed session and whatever answered it. Prescription on the left, what actually
 * happened on the right — the comparison is the whole point of the row, so it is never
 * split across two lines.
 */
export function SessionRow({
  match,
  onToggle,
  onEdit,
}: {
  match: MatchedSession
  /** Absent for sessions a Strava activity already settled — there is nothing to tick. */
  onToggle?: () => void
  onEdit?: () => void
}) {
  const { session, activity, done } = match
  const meta = SESSION_META[session.type]

  const target =
    session.targetDistanceM != null
      ? `${formatKm(session.targetDistanceM)} km`
      : session.targetDurationS != null
        ? formatDuration(session.targetDurationS)
        : null
  const paces = formatPaceRange(session.targetPaceLoSKm, session.targetPaceHiSKm)
  const prescription = [target, paces].filter(Boolean).join(' · ')

  return (
    <div className="flex items-start gap-3 py-3">
      {onToggle ? (
        <button
          type="button"
          onClick={onToggle}
          aria-pressed={done}
          aria-label={done ? `Mark ${session.title} not done` : `Mark ${session.title} done`}
          className={cn(
            'mt-0.5 size-5 shrink-0 rounded-md border transition-colors',
            done ? 'border-emerald-500 bg-emerald-500/20 text-emerald-400' : 'border-neutral-700',
          )}
        >
          {done ? '✓' : ''}
        </button>
      ) : (
        <span
          aria-hidden
          className={cn(
            'mt-1.5 size-2 shrink-0 rounded-full',
            done ? 'bg-emerald-500' : 'bg-neutral-700',
          )}
        />
      )}

      <button
        type="button"
        onClick={onEdit}
        disabled={!onEdit}
        className="flex min-w-0 flex-1 items-start justify-between gap-3 text-left disabled:cursor-default"
      >
        <span className="min-w-0">
          <span className="flex items-center gap-2">
            <span className="text-[0.6875rem] uppercase tracking-widest text-neutral-500">
              {meta.label}
            </span>
          </span>
          <span className={cn('block truncate text-sm', done && 'text-neutral-400')}>
            {session.title}
          </span>
          {prescription ? (
            <span className="block text-xs tabular-nums text-neutral-500">{prescription}</span>
          ) : null}
        </span>

        {activity ? (
          <span className="shrink-0 text-right">
            <span className="block text-sm tabular-nums text-emerald-400">
              {formatKm(activity.distanceM)} km
            </span>
            <span className="block text-xs tabular-nums text-neutral-500">
              {formatPace(paceSKm(activity.distanceM, activity.movingS))}/km
            </span>
          </span>
        ) : null}
      </button>
    </div>
  )
}

/** A run that answered no prescribed session — shown so a week's total always adds up. */
export function ExtraRow({ activity }: { activity: { name: string; distanceM: number; movingS: number; sportType: string } }) {
  return (
    <div className="flex items-start justify-between gap-3 py-3">
      <div className="flex min-w-0 items-start gap-3">
        <span aria-hidden className="mt-1.5 size-2 shrink-0 rounded-full bg-neutral-700 ring-2 ring-neutral-800" />
        <div className="min-w-0">
          <p className="text-[0.6875rem] uppercase tracking-widest text-neutral-600">Unplanned</p>
          <p className="truncate text-sm text-neutral-300">{activity.name}</p>
        </div>
      </div>
      <div className="shrink-0 text-right">
        <p className="text-sm tabular-nums text-neutral-300">{formatKm(activity.distanceM)} km</p>
        <p className="text-xs tabular-nums text-neutral-500">
          {formatPace(paceSKm(activity.distanceM, activity.movingS))}/km
        </p>
      </div>
    </div>
  )
}
