import { useState } from 'react'
import { formatDuration, formatKm } from '@/lib/activity'
import { DAY_MS, startOfDay } from '@/lib/block'
import { cn } from '@/lib/cn'
import type { Activity } from '@/lib/db/schema'
import type { DayPlan, MatchedSession, WeekPlan } from '@/lib/plan'
import { SessionCard } from './SessionCard'
import { ACCENT, Card, CardTitle } from './ui'

/**
 * The week as seven lines, and the session you are about to run in full.
 *
 * A card per day is a scroll; a line per day is a glance. A line carries only what says
 * whether a day is behind you — its colour, what it asks for, and what answered it — and
 * the detail that used to be repeated on every card is spent once, on the one session
 * that has not happened yet. Tapping a line moves that detail onto it, so the days
 * already run are one tap away rather than permanently in the way.
 */

const rowFmt = new Intl.DateTimeFormat('es-ES', {
  weekday: 'short',
  day: 'numeric',
  // Dates are UTC midnight of the local day; formatting in the viewer's zone slides them.
  timeZone: 'UTC',
})
const detailFmt = new Intl.DateTimeFormat('es-ES', {
  weekday: 'short',
  day: 'numeric',
  month: 'short',
  timeZone: 'UTC',
})

export function ThisWeek({
  week,
  today,
  onToggle,
}: {
  week: WeekPlan
  /** UTC midnight of the current local day. */
  today: number
  onToggle: (match: MatchedSession) => void
}) {
  // `null` lets the detail follow the plan forward; picking a line pins it there instead.
  const [picked, setPicked] = useState<string | null>(null)

  const upcoming = nextSession(week, today)
  const selected = week.sessions.find((m) => m.session.id === picked) ?? upcoming
  const empty = week.days.every((d) => d.sessions.length === 0 && d.extras.length === 0)

  return (
    <Card>
      <CardTitle
        action={
          <a href="/plan" className="text-xs text-neutral-400 underline underline-offset-4">
            Editar plan
          </a>
        }
      >
        Esta semana
      </CardTitle>

      {empty ? (
        <p className="text-sm text-neutral-500">
          Aún no hay nada planificado para esta semana.{' '}
          <a href="/plan" className="underline underline-offset-4">
            Escríbelo
          </a>
          .
        </p>
      ) : (
        <>
          <ul className="-mx-2 divide-y divide-neutral-800/60">
            {week.days.map((day) => (
              <DayLines
                key={day.date}
                day={day}
                today={today}
                selectedId={selected?.session.id ?? null}
                onSelect={setPicked}
                onToggle={onToggle}
              />
            ))}
          </ul>

          <div className="mt-4 border-t border-neutral-800 pt-4">
            {selected ? (
              <>
                <p className="mb-2 text-[0.6875rem] font-medium uppercase tracking-widest">
                  <span className="text-neutral-300">
                    {whenLabel(startOfDay(selected.session.scheduledOn), today)}
                  </span>
                  {selected === upcoming ? (
                    <span className="text-neutral-600"> · siguiente</span>
                  ) : null}
                </p>
                <SessionCard
                  // Keyed on the session, so picking another line opens that one rather
                  // than handing its steps to a card still holding the last one's state.
                  key={selected.session.id}
                  match={selected}
                  defaultOpen
                  // A matched activity already settles the question; only sessions Strava
                  // will never report — strength, cross — get a tick box.
                  onToggle={selected.activity ? undefined : () => onToggle(selected)}
                />
              </>
            ) : (
              // Not "all done": a week can run out of sessions ahead of you because they
              // were run, or because they were missed. The lines above say which.
              <p className="text-sm text-neutral-500">
                Ya no queda nada esta semana. Toca un día para mirar atrás.
              </p>
            )}
          </div>
        </>
      )}
    </Card>
  )
}

/** The first session still owed, from today forward. What the detail below is for. */
function nextSession(week: WeekPlan, today: number): MatchedSession | null {
  for (const day of week.days) {
    if (day.date < today) continue
    for (const match of day.sessions) {
      if (!match.done && match.session.type !== 'rest') return match
    }
  }
  return null
}

function whenLabel(date: number, today: number): string {
  if (date === today) return 'Hoy'
  if (date === today + DAY_MS) return 'Mañana'
  if (date === today - DAY_MS) return 'Ayer'
  return detailFmt.format(new Date(date))
}

/** One day of the week: its sessions, whatever else was run, or a rest line. */
function DayLines({
  day,
  today,
  selectedId,
  onSelect,
  onToggle,
}: {
  day: DayPlan
  today: number
  selectedId: string | null
  onSelect: (id: string) => void
  onToggle: (match: MatchedSession) => void
}) {
  const label = rowFmt.format(new Date(day.date))
  const isToday = day.date === today

  return (
    <li>
      {day.sessions.map((match, i) => (
        <SessionLine
          key={match.session.id}
          match={match}
          // A double day is one block under one date, not the same date said twice.
          label={i === 0 ? label : ''}
          isToday={isToday}
          selected={match.session.id === selectedId}
          onSelect={() => onSelect(match.session.id)}
          onToggle={() => onToggle(match)}
        />
      ))}

      {day.extras.map((activity, i) => (
        <ExtraLine
          key={activity.id}
          activity={activity}
          label={day.sessions.length === 0 && i === 0 ? label : ''}
          isToday={isToday}
        />
      ))}

      {day.sessions.length === 0 && day.extras.length === 0 ? (
        <RestLine label={label} isToday={isToday} />
      ) : null}
    </li>
  )
}

function DayLabel({ children, isToday }: { children: string; isToday: boolean }) {
  return (
    <span
      className={cn(
        'w-14 shrink-0 text-[0.625rem] font-medium uppercase tracking-wide tabular-nums',
        isToday ? 'text-neutral-100' : 'text-neutral-600',
      )}
    >
      {children}
    </span>
  )
}

function SessionLine({
  match,
  label,
  isToday,
  selected,
  onSelect,
  onToggle,
}: {
  match: MatchedSession
  label: string
  isToday: boolean
  selected: boolean
  onSelect: () => void
  onToggle: () => void
}) {
  const { session, activity, done } = match
  // What happened, or failing that what was asked for — one number, never both, because
  // the bars above already carry planned against actual.
  const value = activity
    ? `${formatKm(activity.distanceM)} km`
    : session.targetDistanceM != null
      ? `${formatKm(session.targetDistanceM)} km`
      : session.targetDurationS != null
        ? formatDuration(session.targetDurationS)
        : null

  return (
    <div className={cn('flex items-center rounded-lg', selected && 'bg-neutral-800/60')}>
      <button
        type="button"
        onClick={onSelect}
        aria-pressed={selected}
        className="flex min-w-0 flex-1 items-center gap-2 py-2 pl-2 text-left"
      >
        <DayLabel isToday={isToday}>{label}</DayLabel>
        <span
          aria-hidden
          className={cn(
            'size-1.5 shrink-0 rounded-full',
            ACCENT[session.type].dot,
            done && 'opacity-40',
          )}
        />
        <span
          className={cn(
            'min-w-0 flex-1 truncate text-[0.8125rem]',
            done ? 'text-neutral-500' : 'text-neutral-200',
          )}
        >
          {session.title}
        </span>
        {value ? (
          <span
            className={cn(
              'shrink-0 text-[0.8125rem] tabular-nums',
              activity ? 'text-emerald-400' : done ? 'text-neutral-600' : 'text-neutral-400',
            )}
          >
            {value}
          </span>
        ) : null}
      </button>

      {session.type === 'rest' ? (
        <span className="w-8" />
      ) : (
        <Tick
          done={done}
          label={session.title}
          // Nothing to tick on a session an activity already answered.
          onToggle={activity ? undefined : onToggle}
        />
      )}
    </div>
  )
}

/** A run that answered no prescribed session — listed so the week still adds up. */
function ExtraLine({
  activity,
  label,
  isToday,
}: {
  activity: Activity
  label: string
  isToday: boolean
}) {
  return (
    <div className="flex items-center">
      <span className="flex min-w-0 flex-1 items-center gap-2 py-2 pl-2">
        <DayLabel isToday={isToday}>{label}</DayLabel>
        <span aria-hidden className="size-1.5 shrink-0 rounded-full border border-neutral-600" />
        <span className="min-w-0 flex-1 truncate text-[0.8125rem] text-neutral-400">
          {activity.name}
        </span>
        <span className="shrink-0 text-[0.8125rem] tabular-nums text-neutral-400">
          {formatKm(activity.distanceM)} km
        </span>
      </span>
      <span className="w-8" />
    </div>
  )
}

/** A day with nothing on it reads as deliberate, not as missing data. */
function RestLine({ label, isToday }: { label: string; isToday: boolean }) {
  return (
    <div className="flex items-center">
      <span className="flex min-w-0 flex-1 items-center gap-2 py-2 pl-2">
        <DayLabel isToday={isToday}>{label}</DayLabel>
        <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-neutral-800" />
        <span className="min-w-0 flex-1 truncate text-[0.8125rem] text-neutral-600">Descanso</span>
      </span>
      <span className="w-8" />
    </div>
  )
}

/** The compact sibling of `DoneToggle` — a line has no room for a 24px box and its padding. */
function Tick({
  done,
  label,
  onToggle,
}: {
  done: boolean
  label: string
  onToggle?: () => void
}) {
  const face = (
    <span
      className={cn(
        'flex size-4 items-center justify-center rounded border text-[0.5rem] font-bold',
        done
          ? 'border-emerald-500/60 bg-emerald-500/15 text-emerald-400'
          : 'border-neutral-800 text-transparent',
      )}
    >
      ✓
    </span>
  )

  if (!onToggle) return <span aria-hidden className="flex px-2">{face}</span>
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={done}
      aria-label={done ? `Marcar ${label} como pendiente` : `Marcar ${label} como hecho`}
      className="flex px-2 py-2"
    >
      {face}
    </button>
  )
}
