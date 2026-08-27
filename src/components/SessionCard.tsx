import { Fragment, useState, type ReactNode } from 'react'
import { formatDuration, formatKm, formatPace, isRun, paceSKm } from '@/lib/activity'
import { cn } from '@/lib/cn'
import { PACE_ZONE_NUMBER, hrZone, zoneTag } from '@/lib/paces'
import { SESSION_META, effortLabel, sessionEffort, type MatchedSession, type SessionType } from '@/lib/plan'
import {
  formatRecovery,
  formatWorkout,
  isEffort,
  paceBandLabel,
  stepHeadline,
  type Bands,
  type Step,
} from '@/lib/workout'
import { ACCENT, Button, Chevron, DoneToggle, TypeChip } from './ui'

/**
 * One prescribed session: what it asks for, what it is made of, and what answered it.
 *
 * The most-repeated unit in the app — the one open card on `/`, every row of an open week
 * on `/plan` — so its geometry is fixed here rather than negotiated per screen.
 *
 * **Three stacked regions, hairline-separated, and each one spans the card.** The header
 * is the row; what unfolds under it is its own region, and so is the result. That is the
 * shape of an iOS cell, and it is what this card was missing: the detail used to hang off
 * the header at a 32px indent with a margin per block, so an opened card put a rule
 * fragment beside the note, dropped its buttons past the bottom padding, and left a
 * column of empty gutter down the left of everything it had unfolded. Regions and one
 * rhythm inside each of them, instead of eight negative margins holding a layout together.
 *
 * The header keeps two measurements and nothing else may reinvent them: the spine is 6px
 * and the tick is 24px. Everything the header stacks — title, effort, workout shape —
 * lives inside the button's own column, so it aligns under the title by construction
 * rather than by a `pl-8` that has to be re-derived every time the gap changes.
 *
 * **The spine runs the card's full height and carries no radius of its own.** The article
 * is `overflow-hidden rounded-xl`, so the corners clip it and it picks up the card's own
 * curve at both ends — one shape, rather than a bar with a second radius fighting the
 * first. Six pixels rather than four, because at four a hue is a tint and telling violet
 * from coral meant comparing two cards; and `spine-fade` takes it to 45% by the bottom, so
 * it reads as lit from the title rather than as a solid bar of paint. It spans every
 * region the card unfolds, which is what ties the workout and the result back to the
 * header they belong to.
 *
 * The 8px gap is narrower than the 10px `DoneToggle` grows its hit area by, and that is
 * fine: the toggle is `position: relative`, so it and its `::after` paint in the
 * positioned layer, above a statically-positioned sibling. The header button never steals
 * the two pixels of overlap, and the tick keeps a true 44px face-to-thumb target.
 *
 * **Every running session states its effort, always** — `Z4 · 3:50–3:58/km · ≈ 52m`, or
 * `A sensaciones` for a rebuild week that prescribes no band. That line used to render
 * only when the session carried `targetPace*` columns of its own, so a run written as a
 * distance and a workout printed a title, a number and nothing else: the one thing a
 * runner needs before leaving the house was the one thing missing, and a blank reads as
 * absent data rather than as "by feel". `sessionEffort` resolves it from the columns, then
 * from the steps, then says so.
 */
export function SessionCard({
  match,
  hrMax,
  bands,
  onToggle,
  onEdit,
  defaultOpen = false,
  from = 'plan',
}: {
  match: MatchedSession
  /** The athlete's max HR, resolved once by the screen — `user.hrMax ?? DEFAULT_HR_MAX`. */
  hrMax: number
  /** The athlete's own six pace bands, resolved once by the screen from their goal pace. */
  bands: Bands
  /** Absent for sessions a Strava activity already settled — there is nothing to tick. */
  onToggle?: () => void
  onEdit?: () => void
  defaultOpen?: boolean
  /** Which tab the detail view should offer as its way back. */
  from?: 'hoy' | 'plan'
}) {
  const [open, setOpen] = useState(defaultOpen)
  const { session, activity, done } = match
  const accent = ACCENT[session.type]

  const steps = session.steps ?? null
  const effort = sessionEffort(session, bands)
  // Strength and cycling are prescribed in minutes; everything that runs, in kilometres.
  const target =
    session.targetDistanceM != null
      ? `${formatKm(session.targetDistanceM)} km`
      : session.targetDurationS != null
        ? formatDuration(session.targetDurationS)
        : null
  // Only what runs has a pace to state: `A sensaciones` under a strength session would be
  // the card answering a question nobody asked of it.
  const meta =
    SESSION_META[session.type].family === 'run'
      ? [effortLabel(effort), effort.estimateS ? `≈ ${formatDuration(effort.estimateS)}` : null]
          .filter(Boolean)
          .join(' · ')
      : null

  // A single step says nothing the header has not already said — "4 km @ 5:00–5:30/km"
  // under a card that reads "4,0 km · 5:00–5:30/km" is the same sentence twice.
  const detailed = steps != null && steps.length > 1
  // A rest day has no workout to open, and so no detail view to open it in.
  const href =
    session.type === 'rest' ? null : `/sesion?id=${encodeURIComponent(session.id)}&desde=${from}`
  const expandable = Boolean(detailed || session.notes || onEdit || href)

  return (
    // No border: the card already sits on a ground two steps lighter than its own, and a
    // rule around a panel that is already darker than what it sits in is the second frame
    // that made a week of these read as a stack of boxes. No blanket opacity on a done one
    // either — dimming the whole article drops `label-3` from 5.4:1 to 3.7:1 and takes the
    // result line down with it. Done is said by the mint tick, the dimmed rail and the
    // recessed title: three carriers, none of them a contrast cut on live data.
    <article className="relative overflow-hidden rounded-xl bg-surface-deep/40">
      <span
        aria-hidden
        className={cn(
          'absolute inset-y-0 left-0 w-1.5 spine-fade',
          accent.rail,
          done && 'opacity-40',
        )}
      />

      <div className="flex items-center gap-2 py-2 pl-3.5 pr-2.5">
        {session.type === 'rest' ? (
          <span aria-hidden className="size-6 shrink-0" />
        ) : (
          <DoneToggle done={done} label={session.title} onToggle={onToggle} />
        )}

        <button
          type="button"
          onClick={() => expandable && setOpen(!open)}
          aria-expanded={expandable ? open : undefined}
          disabled={!expandable}
          // A disabled button never sees `:active`, so the press state costs a card with
          // nothing to unfold nothing.
          className="tappable flex min-h-11 min-w-0 flex-1 items-center text-left disabled:cursor-default"
        >
          {/* Two flexes, not one, and each is doing a different job. The button is 44px
              because that is the touch floor, and a collapsed card's two lines are shorter
              than that — so the button centres, and the slack falls above and below the
              content instead of all of it underneath. Inside, `items-baseline` is what
              pairs the title with the distance: the number is a step up the ramp, and
              aligning two sizes by their box tops leaves it floating. */}
          <span className="flex min-w-0 flex-1 items-baseline justify-between gap-2">
            <span className="min-w-0">
              <span className="flex flex-wrap items-center gap-1.5">
                {/* The chip is what pairs the rail's hue with a word — colour is never the
                    only thing saying which kind of session this is. */}
                <TypeChip type={session.type} />
                <span className={cn('text-footnote font-medium', done ? 'text-label-2' : 'text-label')}>
                  {session.title}
                </span>
              </span>

              {meta ? (
                <span className="mt-1 block text-caption tabular-nums text-label-3">{meta}</span>
              ) : null}

              {detailed && !open ? <WorkoutLine steps={steps} bands={bands} /> : null}
            </span>

            <span className="flex shrink-0 items-center gap-1.5">
              {target ? (
                // Once an activity has answered the session the plan's number is the
                // secondary one — what was actually run leads, in mint, below.
                <span
                  className={cn(
                    'data-number text-subhead font-semibold',
                    done ? 'text-label-2' : 'text-label',
                  )}
                >
                  {target}
                </span>
              ) : null}
              {expandable ? <Chevron open={open} /> : null}
            </span>
          </span>
        </button>
      </div>

      {open && expandable ? (
        // One region, one rhythm: `space-y-2.5` between the workout, the note and the
        // actions, and no margins of their own. The note needs no rule beside it — the
        // hairline above already says this is a different part of the cell, and a second
        // rule inside it was a frame around one paragraph.
        <div className="fade-up space-y-2.5 border-t border-line px-3.5 pb-2.5 pt-2.5">
          {detailed ? <StepList steps={steps} type={session.type} bands={bands} /> : null}
          {session.notes ? (
            // Coaching prose, so it gets the one thing prose needs and data does not: a
            // step up in size and open leading.
            <p className="text-footnote leading-relaxed text-label-2">{session.notes}</p>
          ) : null}
          {href || onEdit ? (
            <div className="flex gap-2">
              {href ? (
                <Button href={href} className="flex-1">
                  Ver la sesión
                </Button>
              ) : null}
              {onEdit ? (
                <Button onClick={onEdit} className={href ? 'flex-1' : 'w-full'}>
                  Editar
                </Button>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}

      {activity ? <Result activity={activity} session={session} hrMax={hrMax} /> : null}
    </article>
  )
}

/**
 * The workout at scanning resolution: the efforts, and nothing around them.
 *
 * Only the steps that *are* the workout. A warm-up and a cool-down are the same 2–3 km
 * every time and the header already carries the total they are part of, so spelling them
 * out on a collapsed card spends two lines saying what the reader knew. `5 × 1 km` is the
 * whole question a planner row has to answer.
 *
 * No zone tags on it any more: the line above now states the session's band outright, so
 * a `Z5` after every effort was the same fact printed twice on consecutive lines. The
 * per-step bands live in the breakdown, where there is room for them to differ.
 */
function WorkoutLine({ steps, bands }: { steps: Step[]; bands: Bands }) {
  const efforts = steps.filter(isEffort)

  return (
    <span className="mt-0.5 block text-caption tabular-nums leading-relaxed text-label-2">
      {efforts.length === 0
        ? // Warm-up and cool-down only — nothing to promote, so say the whole thing.
          formatWorkout(steps, bands)
        : efforts.map((step) => stepHeadline(step)).join(' · ')}
    </span>
  )
}

/**
 * The workout, one step per line, with the recovery hanging off the set it belongs to.
 *
 * The right column grades with the step: an effort carries its zone *and* its exact band
 * (`Z5 · 3:30–3:40/km`), the running that brackets it carries only the zone. That is how
 * the session is actually coached — the reps are run to the watch, the warm-up is run to
 * feel — and it is also what keeps the line inside 320px, where a full band on every row
 * would collide with `2 km de vuelta a la calma`.
 *
 * Recoveries and step notes hang under their step with the dot column left empty. Position
 * is what marks them as part of the set; the hairline they used to carry was a frame
 * around a single line of text. They hang at `pl-3.5` — the dot's 6px plus the 8px gap
 * beside it — so the second line of a set starts under the first, not under its marker.
 */
function StepList({ steps, type, bands }: { steps: Step[]; type: SessionType; bands: Bands }) {
  const accent = ACCENT[type]

  return (
    <ol className="space-y-2">
      {steps.map((step, i) => {
        const effort = isEffort(step)
        const zone = step.zone ? zoneTag(PACE_ZONE_NUMBER[step.zone]) : null
        const detail = effort
          ? [zone, paceBandLabel(step.zone, bands)].filter(Boolean).join(' · ')
          : zone

        return (
          <li key={i}>
            <div className="flex items-baseline justify-between gap-3">
              <span className="flex min-w-0 items-baseline gap-2">
                <span
                  aria-hidden
                  className={cn(
                    'size-1.5 shrink-0 -translate-y-px rounded-full',
                    effort && step.zone ? accent.dot : 'bg-fill-strong',
                  )}
                />
                <span
                  className={cn(
                    'text-footnote tabular-nums',
                    effort ? 'text-label' : 'text-label-3',
                  )}
                >
                  {stepHeadline(step)}
                </span>
              </span>
              {detail ? (
                <span className="shrink-0 text-caption tabular-nums text-label-3">{detail}</span>
              ) : null}
            </div>

            {step.recovery && step.reps > 1 ? (
              <p className="mt-1 pl-3.5 text-caption tabular-nums text-label-3">
                {formatRecovery(step.recovery)} entre series
              </p>
            ) : null}
            {step.note ? (
              <p className="mt-1 pl-3.5 text-caption leading-relaxed text-label-3">{step.note}</p>
            ) : null}
          </li>
        )
      })}
    </ol>
  )
}

/**
 * What actually happened, against what was asked for.
 *
 * Its own region under a hairline, and two lines rather than one wrapping row of five
 * loose numbers: the answer in mint (how far, how fast), then the context under it (how it
 * compares to the prescription, and how it was run). Five equal-weight figures wrapping
 * mid-phrase is what this used to be, and it read as a spill rather than as a result.
 *
 * Mint is doing the state-telling, and it is on the numbers, where it is paired with them
 * rather than washed behind them.
 */
function Result({
  activity,
  session,
  hrMax,
}: {
  activity: NonNullable<MatchedSession['activity']>
  session: MatchedSession['session']
  hrMax: number
}) {
  const pace = isRun(activity.sportType) ? paceSKm(activity.distanceM, activity.movingS) : null
  const target = session.targetDistanceM
  const delta = target ? (activity.distanceM - target) / 1000 : null

  const context: ReactNode[] = []
  // Only when it is worth mentioning, and said in words — `+0,4 km` on its own is a number
  // with no second operand, and the target it is measured against is two lines up.
  if (delta != null && Math.abs(delta) >= 0.2) {
    context.push(`${formatKm(Math.abs(delta) * 1000)} km ${delta > 0 ? 'de más' : 'de menos'}`)
  }
  if (activity.cadenceSpm) {
    // docs/03 §6: cadence is the injury fix and the race-form marker, so it is the one
    // secondary number worth carrying on every completed run. 170 spm is the protocol's
    // floor, which is what the colour is reporting against.
    context.push(
      <span className={activity.cadenceSpm >= 170 ? 'text-mint' : 'text-amber'}>
        {activity.cadenceSpm} pasos/min
      </span>,
    )
  }
  if (activity.averageHeartrate) {
    // The zone, never the number: 151 ppm means nothing without the day's heat, sleep and
    // strap behind it, and no decision in the plan is made on the exact figure.
    context.push(zoneTag(hrZone(activity.averageHeartrate, hrMax)))
  }

  return (
    <div className="border-t border-line px-3.5 py-2">
      <p className="data-number text-footnote font-semibold text-mint">
        {formatKm(activity.distanceM)} km
        {pace ? <span className="ml-2 font-medium">{formatPace(pace)}/km</span> : null}
      </p>
      {context.length > 0 ? (
        <p className="mt-1 flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5 text-caption tabular-nums text-label-3">
          {context.map((item, i) => (
            <Fragment key={i}>
              {i > 0 ? (
                <span aria-hidden className="text-label-4">
                  ·
                </span>
              ) : null}
              {item}
            </Fragment>
          ))}
        </p>
      ) : null}
    </div>
  )
}

/**
 * A run that answered no prescribed session — shown so a week's total always adds up.
 *
 * Built on the same skeleton as `SessionCard` down to the empty 24px tick column, because
 * the two alternate down a day in `/plan` and a row that starts its text 24px further
 * left reads as a different component rather than as the same one saying less. What it
 * drops is the colour: a neutral rail, and the name where the title goes.
 */
export function ExtraCard({
  activity,
}: {
  activity: { name: string; distanceM: number; movingS: number; sportType: string }
}) {
  const pace = isRun(activity.sportType)
    ? `${formatPace(paceSKm(activity.distanceM, activity.movingS))}/km`
    : null

  return (
    <article className="relative overflow-hidden rounded-xl bg-surface-deep/40">
      <span
        aria-hidden
        className="absolute inset-y-0 left-0 w-1.5 bg-fill-strong spine-fade"
      />

      <div className="flex items-center gap-2 py-2 pl-3.5 pr-2.5">
        <span aria-hidden className="size-6 shrink-0" />
        <div className="flex min-h-11 min-w-0 flex-1 items-center">
          {/* The same two-flex split `SessionCard` uses: 44px for the touch floor, the
              content centred in it, and the baseline pairing kept for the name and the
              number. */}
          <div className="flex min-w-0 flex-1 items-baseline justify-between gap-2">
            <span className="min-w-0">
              <span className="block truncate text-footnote font-medium text-label-2">
                {activity.name}
              </span>
              <span className="mt-1 block text-caption tabular-nums text-label-3">
                {['Sin planificar', pace].filter(Boolean).join(' · ')}
              </span>
            </span>
            <span className="data-number shrink-0 text-subhead font-semibold text-label-2">
              {formatKm(activity.distanceM)} km
            </span>
          </div>
        </div>
      </div>
    </article>
  )
}
