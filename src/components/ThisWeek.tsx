import { useState } from 'react'
import { formatDuration, formatKm } from '@/lib/activity'
import { DAY_MS, startOfDay } from '@/lib/block'
import { cn } from '@/lib/cn'
import type { Activity } from '@/lib/db/schema'
import { sessionEffort, type DayPlan, type MatchedSession, type SessionType, type WeekPlan } from '@/lib/plan'
import type { Bands } from '@/lib/workout'
import { SessionCard } from './SessionCard'
import { ACCENT, Card, CardTitle, CHECK, EmptyState, Icon, IconAction, PENCIL, TextLink } from './ui'

/**
 * Two sections under one title: the session you are about to run, and the week it sits in.
 *
 * The top half is one `SessionCard` opened in full — what is owed next, with its steps, its
 * note and the way into `/sesion`. The bottom half is the ledger: seven days as lines, each
 * carrying only what says whether a day is behind you. Tapping a line moves the card above
 * onto it, so a day already run is one tap away rather than permanently in the way; tapping
 * it again, or the "ver la siguiente" link the pinned state grows, hands the card back to
 * the plan.
 *
 * **A row is read left to right in the order the questions are asked**: what kind of
 * session, which day, what it is called, and how much of it. Tile, date, title, numbers —
 * one line, four fields, and the columns are fixed widths so seven titles start at one x
 * rather than at seven.
 *
 * **One mark per row, and it is the tile.** A row used to open with a 28px gradient tile in
 * the session's hue *and* close with a hollow tick, so a week rendered sixteen marks: eight
 * saying what kind, eight saying nothing at all. The tile is the good half — at fifty times
 * a rail's area a hue is a colour rather than a tint, and it is what lets a week be scanned
 * at arm's length — so the tick moved *into* it rather than sitting in a column of its own.
 * The tile now carries both channels at once, type in the hue it always had and state in
 * what is drawn on it:
 *
 * - **owed** — the tile, plain. The hue, at full strength, and nothing else on it.
 * - **done** — the same tile with a tick knocked out of it in `surface`, the way a stamp is
 *   pressed into paper. Nothing is dimmed: a week gone grey by Sunday is a week that stops
 *   reading as a week.
 * - **missed** — the tile faded to 40%. A day behind you that nothing answered.
 * - **unplanned** — hollow, no hue: it happened, nobody asked for it.
 * - **rest** — the neutral fill, so the column stays straight without claiming a colour.
 *
 * Colour is never the only carrier. The tick is a shape, the fade is a luminance, and the
 * row's ink drops a step behind each of them — so the three states are told apart with the
 * hues covered up.
 *
 * The tile is also the *control*: it is what you tap to tick a session Strava will never
 * report, with the app's own 44px hit area grown from a pseudo-element so the face stays
 * 28px. That is one object doing what two used to, which is the whole reason the row lost a
 * column and its titles stopped truncating.
 *
 * **The numbers are stacked, not strung out.** How far over how long — `9,0 km` with
 * `≈ 47m` under it — because at the end of a row those are one answer to one question and
 * `9,0 km · ≈ 47m` on a single line costs 50px of the title beside it. The `≈` is the
 * honest half: it is there for a duration this app *estimated* from a distance and a band,
 * and gone the moment the number is one Strava actually recorded.
 *
 * A row is 44px because it is a target; a rest day is 36 and an unplanned run 40 because
 * they are not. That is the list's rhythm, and it is what stops seven lines reading as one
 * block.
 *
 * The rows arrive staggered 30 ms apart, so the eye is walked down the week rather than
 * handed all seven at once — brightening rather than travelling, because the card they sit
 * in is already doing the travelling. See `DayLines`.
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
  hrMax,
  bands,
  onToggle,
}: {
  week: WeekPlan
  /** UTC midnight of the current local day. */
  today: number
  /** The athlete's max HR, resolved once by the screen — `user.hrMax ?? DEFAULT_HR_MAX`. */
  hrMax: number
  /** The athlete's own six pace bands, resolved once by the screen from their goal pace. */
  bands: Bands
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
          empty ? null : <IconAction icon={PENCIL} label="Editar plan" href="/plan" />
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
                  <span className="text-accent">{pinned ? null : ' · siguiente'}</span>
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
                hrMax={hrMax}
                bands={bands}
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

          {/* The rule bleeds to the card's own edges — it is the seam between the two
              halves of this card, not a hairline between two paragraphs of one. Nothing
              separates the rows below it: seven tiles down the left edge already group the
              list, and a hairline under each one was a second grid drawn over the first. */}
          <ul className="-mx-3 mt-3 border-t border-line px-3 pt-2">
            {week.days.map((day, i) => (
              <DayLines
                key={day.date}
                day={day}
                index={i}
                today={today}
                bands={bands}
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
  bands,
  selectedId,
  onSelect,
  onToggle,
}: {
  day: DayPlan
  /** Position in the week, which is also its place in the reveal. */
  index: number
  today: number
  bands: Bands
  selectedId: string | null
  onSelect: (id: string) => void
  onToggle: (match: MatchedSession) => void
}) {
  const label = rowFmt.format(new Date(day.date))
  const isToday = day.date === today
  const past = day.date < today

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
      {day.sessions.map((match, i) =>
        match.session.type === 'rest' ? (
          <RestLine key={match.session.id} label={i === 0 ? label : ''} isToday={isToday} />
        ) : (
          <SessionLine
            key={match.session.id}
            match={match}
            bands={bands}
            // A double day is one block under one date, not the same date said twice.
            label={i === 0 ? label : ''}
            isToday={isToday}
            past={past}
            selected={match.session.id === selectedId}
            onSelect={() => onSelect(match.session.id)}
            onToggle={() => onToggle(match)}
          />
        ),
      )}

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

/** The tile's geometry, shared by all three kinds of row so their dates start at one x. */
const TILE =
  'motion-standard flex size-7 shrink-0 items-center justify-center rounded-[0.625rem] transition-opacity'

/** Drawn, never typed: `✓` resolves to whichever font the device has, at whichever weight. */
const TICK = <Icon path={CHECK} strokeWidth={3.5} className="size-3.5 text-surface" />

/** Everything after the tile, so the three kinds of line share one set of columns. */
const LINE = 'flex min-h-11 min-w-0 flex-1 items-center gap-2.5 text-left'

/**
 * The 28px tile every row opens with — the session's kind, and whether it happened.
 *
 * It replaced a 4px rail in an 8px column. The rail was correct and unreadable: at four
 * pixels a hue is a tint, and telling violet from coral at that width is a thing the eye
 * does by comparing two rows rather than by reading one. A tile is the same information at
 * fifty times the area, and it is what lets a week be scanned by colour at arm's length,
 * which is the whole reason the session types have hues at all. Squared off at
 * `rounded-[0.625rem]` rather than round, because a circle at this size reads as an avatar.
 *
 * What it gained is the tick, knocked out of the hue in `surface` — the app's own glyph at
 * the app's own weight, drawn rather than typed, so it does not arrive at whatever weight
 * and baseline the device's font happens to give `✓`. That tick is why the row no longer
 * ends in a 24px circle: "which session is this" and "did I do it" are one question asked
 * of one object, and the second used to be answered in a column of seven empty rings.
 *
 * It is a `<button>` wherever there is something to toggle and a `<span>` where an activity
 * has already settled the question. The hit area is grown to 44px by a pseudo-element
 * rather than by padding, which is the trick `DoneToggle` uses and for the same reason:
 * padding it out would eat the gap to the date and drag every column after it off its grid.
 */
function Tile({
  type,
  state,
  label,
  onToggle,
}: {
  type: SessionType
  state: 'done' | 'owed' | 'missed'
  /** The session's title, which is what the toggle's spoken label names. */
  label: string
  /** Absent for a session an activity already answered — there is nothing to tick. */
  onToggle?: () => void
}) {
  const done = state === 'done'
  const shape = cn(
    TILE,
    ACCENT[type].swatch,
    // Held at full strength on a done row — the tick and the accent distance already say
    // so twice, and a fade there would take the whole back half of the week with it. A
    // missed day is the one thing this list recedes.
    state === 'missed' && 'opacity-40',
  )

  if (!onToggle)
    return (
      <span role="img" aria-label={done ? 'Hecha' : 'Pendiente'} className={shape}>
        {done ? TICK : null}
      </span>
    )
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={done}
      aria-label={done ? `Marcar ${label} como pendiente` : `Marcar ${label} como hecho`}
      className={cn(
        shape,
        'relative active:opacity-60 after:absolute after:-inset-2 after:content-[""]',
      )}
    >
      {done ? TICK : null}
    </button>
  )
}

function DayLabel({ children, isToday }: { children: string; isToday: boolean }) {
  return (
    <span
      className={cn(
        // 48px holds "sáb 30" uppercased at 11px, and holds it at a fixed width so seven
        // titles start on one line rather than on seven.
        'w-12 shrink-0 whitespace-nowrap text-caption2 font-medium uppercase tracking-wide tabular-nums',
        // `label-3`, not `label-4`: the date is data, and `label-4` is the one step that
        // misses AA, so nothing but chrome may wear it.
        isToday ? 'text-accent' : 'text-label-3',
      )}
    >
      {children}
    </span>
  )
}

/**
 * How far, over how long — the two numbers a line ends on, stacked and right-aligned.
 *
 * Stacked because they are one answer: `9,0 km · ≈ 47m` strung along the row costs 50px of
 * the title beside it and buys nothing, where two lines of tabular figures against a common
 * right edge is a column the eye runs down. The second line is always the quiet one — the
 * distance is what the week is counted in, the duration is what it will cost you.
 */
function Metric({ value, under, tone }: { value: string; under: string | null; tone: string }) {
  return (
    <span className="flex shrink-0 flex-col items-end">
      <span className={cn('data-number text-footnote leading-tight', tone)}>{value}</span>
      {under ? (
        <span className="data-number text-caption2 leading-tight text-label-3">{under}</span>
      ) : null}
    </span>
  )
}

/**
 * One prescribed session, as a line.
 *
 * Three steps of ink and no fourth: today's owed session is at full strength, everything
 * else still standing is a step down, and a day behind you that nothing answered is a step
 * below that. Done sits with the living rows rather than below them — a week that greys out
 * as it is run is a week that stops reading as a week — and says so through the tile's tick
 * and through the one accent number at the end of the row.
 *
 * The distance is the actual one where there is one and the prescribed one otherwise, never
 * both: `WeekHero` one card up already carries planned against actual, and the accent is
 * what tells the two apart here. The duration under it follows the same rule and drops its
 * `≈` when the number stops being an estimate.
 */
function SessionLine({
  match,
  bands,
  label,
  isToday,
  past,
  selected,
  onSelect,
  onToggle,
}: {
  match: MatchedSession
  bands: Bands
  label: string
  isToday: boolean
  past: boolean
  selected: boolean
  onSelect: () => void
  onToggle: () => void
}) {
  const { session, activity, done } = match
  const missed = past && !done

  // Strength and cycling are prescribed in minutes and carry no distance, so their one
  // number is the duration itself — printing it twice, once as the headline and once as an
  // estimate under it, would be the row saying the same thing to itself.
  const effort = sessionEffort(session, bands)
  const value = activity
    ? `${formatKm(activity.distanceM)} km`
    : session.targetDistanceM != null
      ? `${formatKm(session.targetDistanceM)} km`
      : session.targetDurationS != null
        ? formatDuration(session.targetDurationS)
        : null
  const under = activity
    ? formatDuration(activity.movingS)
    : session.targetDistanceM != null && effort.estimateS != null
      ? `≈ ${formatDuration(effort.estimateS)}`
      : null

  return (
    // The 6px bleed is the selected row's background reaching past the card's text column
    // on both sides, so a pinned day reads as a lifted row rather than as a pill floating
    // inside one. `px-1.5` puts the content back where it was. It wraps the tile and the
    // date as well as the title: the row is the day, and half a day highlighted is a
    // selection that looks like a rendering fault.
    <div
      className={cn(
        'motion-standard -mx-1.5 flex items-center gap-2.5 rounded-xl px-1.5 transition-colors',
        selected && 'bg-fill',
      )}
    >
      <Tile
        type={session.type}
        state={done ? 'done' : missed ? 'missed' : 'owed'}
        label={session.title}
        onToggle={activity ? undefined : onToggle}
      />
      <button type="button" onClick={onSelect} aria-pressed={selected} className={cn('tappable', LINE)}>
        <DayLabel isToday={isToday}>{label}</DayLabel>
        <span
          className={cn(
            'min-w-0 flex-1 truncate text-subhead',
            missed ? 'text-label-3' : isToday && !done ? 'text-label' : 'text-label-2',
          )}
        >
          {session.title}
        </span>
        {value ? (
          <Metric
            value={value}
            under={under}
            tone={done ? 'text-accent' : missed ? 'text-label-3' : 'text-label-2'}
          />
        ) : null}
      </button>
    </div>
  )
}

/**
 * A run that answered no prescribed session — listed so the week still adds up.
 *
 * Hollow, not filled: it happened, it just was not asked for, so it takes the tile's
 * outline and none of its colour — a session's hue belongs to the plan. The outline is the
 * faint `line` rather than `line-strong`, because at full strength an empty rounded square
 * in a column of filled ones reads as an unticked box, which is the one thing it is not.
 * Its name comes from Strava and so is whatever the phone called it, which is why it sits a
 * step back in ink from the sessions around it. Nothing to tap: 40px rather than 44.
 */
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
    <div className="flex items-center gap-2.5">
      <span aria-hidden className={cn(TILE, 'ring-1 ring-inset ring-line')} />
      <span className={cn(LINE, 'min-h-10')}>
        <DayLabel isToday={isToday}>{label}</DayLabel>
        <span className="min-w-0 flex-1 truncate text-subhead text-label-3">{activity.name}</span>
        <Metric
          value={`${formatKm(activity.distanceM)} km`}
          under={formatDuration(activity.movingS)}
          tone="text-accent"
        />
      </span>
    </div>
  )
}

/**
 * A day with nothing on it reads as deliberate, not as missing data.
 *
 * It keeps the tile — the neutral fill, so the column stays straight without claiming a hue
 * — and gives back the height instead: 36px against a session's 44, because there is
 * nothing here to put a thumb on. That difference is the list's beat. Seven identical rows
 * are a block; five tall ones with two short ones between them are a week.
 */
function RestLine({ label, isToday }: { label: string; isToday: boolean }) {
  return (
    <div className="flex items-center gap-2.5">
      <span aria-hidden className={cn(TILE, ACCENT.rest.swatch)} />
      <span className={cn(LINE, 'min-h-9')}>
        <DayLabel isToday={isToday}>{label}</DayLabel>
        <span className="min-w-0 flex-1 truncate text-footnote text-label-3">Descanso</span>
      </span>
    </div>
  )
}
