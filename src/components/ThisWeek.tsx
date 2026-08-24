import { useState, type ReactNode } from 'react'
import { formatDuration, formatKm } from '@/lib/activity'
import { DAY_MS, startOfDay } from '@/lib/block'
import { cn } from '@/lib/cn'
import type { Activity } from '@/lib/db/schema'
import type { DayPlan, MatchedSession, WeekPlan } from '@/lib/plan'
import { SessionCard } from './SessionCard'
import { ACCENT, Card, CardTitle, DoneToggle, EmptyState, TextLink } from './ui'

/**
 * The week as seven lines, and the session you are about to run in full.
 *
 * A card per day is a scroll; a line per day is a glance. A line carries only what says
 * whether a day is behind you — its kind, what it asks for, and what answered it — and
 * the detail that used to be repeated on every card is spent once, on the one session
 * that has not happened yet. Tapping a line moves that detail onto it, so the days
 * already run are one tap away rather than permanently in the way. Tapping it again, or
 * the "ver la siguiente" link the pinned state grows, hands the card back to the plan:
 * a detail pinned to last Tuesday with no way out is a screen that has quietly stopped
 * answering "what do I run today".
 *
 * Three things tell one line from another and none of them is colour on its own: the
 * *shape* in the marker column (a rail for a prescribed session, a ring for a run nobody
 * asked for, a hairline for a rest day), the tick at the end of the row, and the mint on
 * a distance that was actually run. The hue on the rail is the session's kind, the same
 * one the strip above and the card below give it.
 *
 * The rows arrive staggered 30 ms apart, so the eye is walked down the week rather than
 * handed all seven at once — brightening rather than travelling, because the card they
 * sit in is already doing the travelling. See `DayLines`.
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
  // `week.sessions` is the same objects `week.days` holds, so this is reference equality
  // and not an id comparison.
  const pinned = selected != null && selected !== upcoming
  const empty = week.days.every((d) => d.sessions.length === 0 && d.extras.length === 0)

  // Re-tapping the open line lets it go, which is the gesture a pressed row implies.
  const select = (id: string) => setPicked((prev) => (prev === id ? null : id))

  return (
    // Every card on `/` reveals with `fade-up`, this one included — and since `ThisWeek`
    // draws its own `Card`, the class can only be put on from in here.
    <Card className="fade-up">
      <CardTitle
        action={
          // Nothing to edit on a week nobody has written yet, and the empty state below
          // already carries the one link that matters. Two routes to `/plan` in one card
          // is a card asking the same question twice.
          empty ? null : (
            <TextLink href="/plan" inset>
              Editar plan
            </TextLink>
          )
        }
      >
        Esta semana
      </CardTitle>

      {empty ? (
        <EmptyState
          action={
            <TextLink href="/plan" tone="primary">
              Escribir la semana
            </TextLink>
          }
        >
          Aún no hay ninguna sesión escrita para esta semana. En cuanto la planifiques
          aparecerá aquí, día a día.
        </EmptyState>
      ) : (
        <>
          {selected ? (
            <>
              {/* `min-h-7` is the height the reset link occupies once it appears (a 44px
                  target pulled back by `-my-2`), reserved whether or not it is there, so
                  pinning a past day does not shove the session card down 14px. */}
              <div className="mb-1.5 flex min-h-7 items-center justify-between gap-2">
                <p className="text-caption2 font-semibold uppercase tracking-[0.12em]">
                  <span className="text-label-2">
                    {whenLabel(startOfDay(selected.session.scheduledOn), today)}
                  </span>
                  {/* Mint is state, and "the next thing you owe" is the state this card
                      exists to report. */}
                  {pinned ? null : <span className="text-mint"> · siguiente</span>}
                </p>
                {pinned && upcoming ? (
                  <TextLink inset className="-mr-2" onClick={() => setPicked(null)}>
                    Ver la siguiente
                  </TextLink>
                ) : null}
              </div>
              <SessionCard
                // Keyed on the session, so picking another line opens that one rather
                // than handing its steps to a card still holding the last one's state.
                key={selected.session.id}
                match={selected}
                defaultOpen
                // The way back out of `/sesion` is the tab it was opened from.
                from="hoy"
                // A matched activity already settles the question; only sessions Strava
                // will never report — strength, cross — get a tick box.
                onToggle={selected.activity ? undefined : () => onToggle(selected)}
              />
            </>
          ) : (
            // Not "all done": a week can run out of sessions ahead of you because they
            // were run, or because they were missed. The lines below say which.
            <EmptyState>
              Ya no queda nada por delante esta semana. Toca un día para mirar atrás.
            </EmptyState>
          )}

          <ul className="-mx-2 mt-2 divide-y divide-line border-t border-line pt-1">
            {week.days.map((day, i) => (
              <DayLines
                key={day.date}
                day={day}
                index={i}
                today={today}
                selectedId={selected?.session.id ?? null}
                onSelect={select}
                onToggle={onToggle}
              />
            ))}
          </ul>
        </>
      )}
    </Card>
  )
}

/** The first session still owed, from today forward. What the leading detail is for. */
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
  index,
  today,
  selectedId,
  onSelect,
  onToggle,
}: {
  day: DayPlan
  /** Position in the week, which is also its place in the reveal. */
  index: number
  today: number
  selectedId: string | null
  onSelect: (id: string) => void
  onToggle: (match: MatchedSession) => void
}) {
  const label = rowFmt.format(new Date(day.date))
  const isToday = day.date === today

  return (
    // `fade-in` rather than `fade-up`, and this is the one place on the screen where that
    // is the right call: the card around these rows is already travelling its 12px, so a
    // row that also travelled would cover 24 on the first frame — past the point the eye
    // stops reading a settle and starts reading a slide. Brightening in sequence inside a
    // card that lifts walks the eye down the week without adding a third energy.
    //
    // The stagger is per *day*, not per row: a double day arrives as one block under one
    // date. Seven days, so the eighth-row cap on the delay can never bind here.
    <li className="fade-in" style={{ animationDelay: `${index * 30}ms` }}>
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

/** Shared by all three kinds of line, so their titles start at the same x. */
const LINE = 'flex min-h-11 min-w-0 flex-1 items-center gap-2 py-2 pl-2 text-left'

function DayLabel({ children, isToday }: { children: string; isToday: boolean }) {
  return (
    <span
      className={cn(
        // 56px holds "sáb 30" uppercased at 11px with room to spare, and holds it at a
        // fixed width so seven titles start on one line rather than on seven.
        'w-14 shrink-0 whitespace-nowrap text-caption2 font-medium uppercase tracking-wide tabular-nums',
        // `label-3`, not `label-4`: the date is data, and `label-4` is the one step that
        // misses AA, so nothing but chrome may wear it.
        isToday ? 'text-mint' : 'text-label-3',
      )}
    >
      {children}
    </span>
  )
}

/**
 * The 8px column every row's kind-marker centres in.
 *
 * The shape in here is what separates the three kinds of line — a rail for a prescribed
 * session, a ring for a run nobody asked for, a hairline for a rest day — so the
 * distinction survives without colour and the titles still line up down the card whatever
 * sits in the slot.
 */
function Marker({ children }: { children: ReactNode }) {
  return (
    <span aria-hidden className="flex w-2 shrink-0 justify-center">
      {children}
    </span>
  )
}

/** Where a tick would be on a row that cannot have one, so the column stays straight. */
function TickSpacer() {
  return <span aria-hidden className="size-6 shrink-0" />
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
  // the weekly summary above already carries planned against actual. Mint is what tells
  // the two apart: a mint distance is one that was actually run.
  const value = activity
    ? `${formatKm(activity.distanceM)} km`
    : session.targetDistanceM != null
      ? `${formatKm(session.targetDistanceM)} km`
      : session.targetDurationS != null
        ? formatDuration(session.targetDurationS)
        : null

  return (
    <div
      className={cn(
        'motion-standard flex items-center gap-2 rounded-xl pr-2 transition-colors',
        selected && 'bg-fill',
      )}
    >
      <button type="button" onClick={onSelect} aria-pressed={selected} className={cn('tappable', LINE)}>
        <DayLabel isToday={isToday}>{label}</DayLabel>
        <Marker>
          {/* The same 4px rail `SessionCard` runs down its left edge, at line scale — and
              dimmed on a done row for the same reason it is dimmed there. */}
          <span className={cn('h-4 w-1 rounded-full', ACCENT[session.type].rail, done && 'opacity-40')} />
        </Marker>
        <span
          className={cn(
            'min-w-0 flex-1 truncate text-footnote',
            done ? 'text-label-3' : 'text-label',
          )}
        >
          {session.title}
        </span>
        {value ? (
          <span
            className={cn(
              'data-number shrink-0 text-footnote',
              activity ? 'text-mint' : done ? 'text-label-3' : 'text-label-2',
            )}
          >
            {value}
          </span>
        ) : null}
      </button>

      {/* The system's toggle rather than a second, squarer one drawn here: it keeps its
          face at 24px and grows the *hit area* to 44 with a pseudo-element, so it is both
          the same control as everywhere else in the app and narrower than the 44px button
          this row used to end with. */}
      {session.type === 'rest' ? (
        <TickSpacer />
      ) : (
        <DoneToggle
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
    <div className="flex items-center gap-2 pr-2">
      <span className={LINE}>
        <DayLabel isToday={isToday}>{label}</DayLabel>
        <Marker>
          {/* Hollow, not filled: it happened, it just was not asked for. */}
          <span className="size-1.5 rounded-full border border-line-strong" />
        </Marker>
        <span className="min-w-0 flex-1 truncate text-footnote text-label-2">{activity.name}</span>
        <span className="data-number shrink-0 text-footnote text-label-2">
          {formatKm(activity.distanceM)} km
        </span>
      </span>
      <TickSpacer />
    </div>
  )
}

/** A day with nothing on it reads as deliberate, not as missing data. */
function RestLine({ label, isToday }: { label: string; isToday: boolean }) {
  return (
    <div className="flex items-center gap-2 pr-2">
      <span className={LINE}>
        <DayLabel isToday={isToday}>{label}</DayLabel>
        <Marker>
          {/* The same hairline the strip puts at the foot of a rest column. */}
          <span className="h-px w-2 bg-fill-strong" />
        </Marker>
        <span className="min-w-0 flex-1 truncate text-footnote text-label-3">Descanso</span>
      </span>
      <TickSpacer />
    </div>
  )
}
