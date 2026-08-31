import type { ReactNode } from 'react'
import { formatDuration } from '@/lib/activity'
import { cn } from '@/lib/cn'
import { PACE_ZONE_NUMBER, zoneTag } from '@/lib/paces'
import type { SessionType } from '@/lib/plan'
import {
  STRATEGIES,
  type Prescription,
  type PrescriptionKind,
  type Prescriptions,
} from '@/lib/prescription'
import { formatExercise, strengthSummary } from '@/lib/strength'
import {
  STEP_ROLE,
  formatDistance,
  formatRecovery,
  formatWorkout,
  hardDistanceM,
  isEffort,
  paceBandLabel,
  stepAmount,
  stepHeadline,
  workoutDistanceM,
  workoutDurationS,
  type Bands,
  type Step,
} from '@/lib/workout'
import { ExerciseThumb } from './exercise-ui'
import { ACCENT, Card, CardTitle, EmptyState, TextLink, ZoneChip } from './ui'

/**
 * How each kind of prescription draws, at the three resolutions the app reads one at.
 *
 * `src/lib/prescription.ts` is the model half of this: a tagged union with one strategy
 * per kind, holding everything that differs about the *data*. This is the other half —
 * everything that differs about the *pixels* — and it is a `Record` over the same kind
 * union for the same reason. A kind added to `Prescriptions` and forgotten here is a build
 * error listing exactly this file, rather than a session that renders as a blank card on
 * somebody's phone.
 *
 * Four resolutions, because the app reads a prescription in four places and they are not
 * the same question:
 *
 *   - **`Line`** — one line under a collapsed card's title. `5 × 1 km` / `8 ejercicios`.
 *     The answer to "what is this" while scrolling a week.
 *   - **`Breakdown`** — what a card unfolds. Enough to decide, still inside a list.
 *   - **`Detail`** — the whole card on `/sesion`, with its own totals. The screen you read
 *     the night before, where four answers per unit is the right density.
 *   - **`Empty`** — the same card with *nothing* in the column. A slot rather than a shared
 *     sentence because the absence means something different per kind and the way out is a
 *     different screen: a run written as a distance and nothing else is not wrong and is
 *     fixed in `/plan`, while a Fuerza day with no exercises is a session nobody can do and
 *     is fixed from `/plantillas`. That sentence used to live in `SessionDetail.tsx` behind
 *     an `else` — so a third kind would have inherited the strength copy, told the athlete
 *     to apply a template, and been clean under `tsc` while doing it.
 *
 * `WorkoutLine`, `StepList` and `Workout` **moved** here — from `SessionCard.tsx` and
 * `SessionDetail.tsx` respectively — rather than being imported back from where they were.
 * The map must not import the components that import the map, and moving them is also what
 * makes the two cards symmetrical: neither one owns a renderer the other has to reach for.
 *
 * The exported wrappers below are where the dispatch actually happens, so the one
 * `as never` this pattern costs is written once instead of at six call sites.
 */

interface ViewProps<K extends PrescriptionKind> {
  p: Prescriptions[K]
  /** The session's type, for its hue. A prescription has no colour of its own. */
  type: SessionType
  /** The athlete's own six pace bands. Meaningless to strength, uniform on purpose. */
  bands: Bands
}

interface PrescriptionView<K extends PrescriptionKind> {
  Line: (props: ViewProps<K>) => ReactNode
  Breakdown: (props: ViewProps<K>) => ReactNode
  Detail: (props: ViewProps<K>) => ReactNode
  /** Rendered when the session's type prescribes this kind and the column is empty. */
  Empty: () => ReactNode
}

/**
 * Whether the payload has a breakdown worth unfolding — the card's `detailed`.
 *
 * A thin wrapper over `STRATEGIES[kind].expands`, and it exists for one reason: indexing
 * the registry with a union key gives a union of strategies, whose `expands` parameters
 * intersect to `never`. The cast is sound because the key and the payload came from the
 * same object, and it is confined to this file and the three wrappers below.
 */
export const expandsPrescription = (p: Prescription): boolean =>
  STRATEGIES[p.kind].expands(p as never)

export function PrescriptionLine(props: { p: Prescription; type: SessionType; bands: Bands }) {
  const { Line } = PRESCRIPTION_VIEWS[props.p.kind]
  return <Line p={props.p as never} type={props.type} bands={props.bands} />
}

export function PrescriptionBreakdown(props: {
  p: Prescription
  type: SessionType
  bands: Bands
}) {
  const { Breakdown } = PRESCRIPTION_VIEWS[props.p.kind]
  return <Breakdown p={props.p as never} type={props.type} bands={props.bands} />
}

export function PrescriptionDetail(props: { p: Prescription; type: SessionType; bands: Bands }) {
  const { Detail } = PRESCRIPTION_VIEWS[props.p.kind]
  return <Detail p={props.p as never} type={props.type} bands={props.bands} />
}

/**
 * The card a session shows when its type prescribes a kind and the column is empty.
 *
 * Keyed by the *kind the type prescribes*, not by a payload — there is no payload; that is
 * the whole state. A type that prescribes nothing (a rest day) never asks for one.
 */
export function PrescriptionEmpty({ kind }: { kind: PrescriptionKind }) {
  const { Empty } = PRESCRIPTION_VIEWS[kind]
  return <Empty />
}

// ---------------------------------------------------------------------------
// Running
// ---------------------------------------------------------------------------

/**
 * The workout at scanning resolution: the efforts, and nothing around them.
 *
 * Only the steps that *are* the workout. A warm-up and a cool-down are the same 2–3 km
 * every time and the header already carries the total they are part of, so spelling them
 * out on a collapsed card spends two lines saying what the reader knew. `5 × 1 km` is the
 * whole question a planner row has to answer.
 *
 * No zone tags on it: the line above states the session's band outright, so a `Z5` after
 * every effort was the same fact printed twice on consecutive lines. The per-step bands
 * live in the breakdown, where there is room for them to differ.
 */
function WorkoutLine({ p, bands }: ViewProps<'run'>) {
  const efforts = p.steps.filter(isEffort)

  return (
    <span className="mt-0.5 block text-caption tabular-nums leading-relaxed text-label-2">
      {efforts.length === 0
        ? // Warm-up and cool-down only — nothing to promote, so say the whole thing.
          formatWorkout(p.steps, bands)
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
function StepList({ p, type, bands }: ViewProps<'run'>) {
  const accent = ACCENT[type]

  return (
    <ol className="space-y-2">
      {p.steps.map((step, i) => {
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
                  className={cn('text-footnote tabular-nums', effort ? 'text-label' : 'text-label-3')}
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
function Workout({ p, type, bands }: ViewProps<'run'>) {
  const steps = p.steps
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
          <TimelineStep key={i} step={step} type={type} bands={bands} last={i === steps.length - 1} />
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
 * A run whose session says nothing but a distance — and that is a legitimate prescription,
 * not a gap. The card says so rather than apologising, and points at the one screen where
 * a breakdown gets written.
 */
function WorkoutEmpty() {
  return (
    <Card className="fade-up">
      <CardTitle>El entrenamiento</CardTitle>
      <EmptyState
        action={
          <TextLink href="/plan" tone="primary">
            Desglosarla en el plan
          </TextLink>
        }
      >
        Esta sesión está escrita como una distancia y nada más — sin calentamiento, series ni
        vuelta a la calma —, así que no hay nada que desglosar paso a paso.
      </EmptyState>
    </Card>
  )
}

// ---------------------------------------------------------------------------
// Strength
//
// The illustration is what makes this kind worth a screen rather than a paragraph, and it
// is also the one thing here that can be absent — the images are mirrored into R2 by an
// operator, out of band. So every layout below is written to read correctly with the tiles
// empty: the name, the numbers and the cue carry the prescription, and `ExerciseThumb`
// paints its own fallback rather than collapsing.
// ---------------------------------------------------------------------------

/** `9 ejercicios` — the collapsed card's one line. The list itself is what unfolds. */
function StrengthLine({ p }: ViewProps<'strength'>) {
  return (
    <span className="mt-0.5 block text-caption leading-relaxed text-label-2">
      {strengthSummary(p.exercises)}
    </span>
  )
}

/**
 * The list at card resolution: numbered, no illustrations, the numbers running on from the
 * name rather than columned against it.
 *
 * The tiles are deliberately not here. A week on `/plan` is a column of these, and nine
 * 56px images inside one row of it is a screenful of pictures for a session nobody has
 * opened yet — the breakdown's job is to answer "what is in this" in the space a workout's
 * step list takes, and the names do that. The illustrations are on `/sesion`, where the
 * question is "how do I do it".
 *
 * And the prescription *flows after* the name instead of sitting in a right-hand column,
 * which is where this differs from `StepList` above and has to. A step's headline is
 * `5 × 1 km`; an exercise's is «Plancha Lateral con Elevación de Pierna» against
 * «3 × 30 s por lado · 45 s descanso» — two long strings, and a 320px row cannot column
 * them. Sharing one paragraph is also the shape `STRENGTH_STRATEGY.lines` writes, so the
 * card and the one-liner say the same sentence.
 */
function StrengthList({ p }: ViewProps<'strength'>) {
  return (
    <ol className="space-y-2">
      {p.exercises.map((exercise, i) => (
        <li key={`${exercise.exerciseId ?? 'libre'}-${i}`} className="flex gap-2">
          <span aria-hidden className="w-3.5 shrink-0 text-caption2 tabular-nums text-label-4">
            {i + 1}
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-footnote leading-snug text-label">
              {exercise.name}{' '}
              <span className="text-caption tabular-nums text-label-3">
                {formatExercise(exercise)}
              </span>
            </p>
            {exercise.note ? (
              <p className="mt-1 text-caption leading-relaxed text-label-3">{exercise.note}</p>
            ) : null}
          </div>
        </li>
      ))}
    </ol>
  )
}

/**
 * The session as a checklist: one block per move, in the order it is done, with the
 * illustration beside it.
 *
 * This is the shape the whole kind exists for. A strength day is read *on a mat*, one move
 * at a time, and the two questions at each of them are "which one is this" and "how many"
 * — a picture and a number, which is why the tile and `formatExercise` are the two things
 * set largest. The cue underneath is the third question, and only sometimes.
 *
 * Numbered rather than ticked. The session carries one `done_at` for the whole block (it
 * is one of the two kinds Strava will never report), and a per-move checkbox would be
 * state with nowhere to live — a promise the row cannot keep across a reload.
 */
function StrengthDetail({ p }: ViewProps<'strength'>) {
  return (
    <Card className="fade-up">
      <CardTitle>Ejercicios</CardTitle>
      <ol className="space-y-3">
        {p.exercises.map((exercise, i) => (
          <li key={`${exercise.exerciseId ?? 'libre'}-${i}`} className="flex gap-2.5">
            <ExerciseThumb exerciseId={exercise.exerciseId} />
            <div className="min-w-0 flex-1">
              <p className="flex min-w-0 items-baseline gap-1.5">
                <span aria-hidden className="shrink-0 text-caption2 tabular-nums text-label-4">
                  {i + 1}
                </span>
                <span className="text-subhead font-semibold leading-snug text-label">
                  {exercise.name}
                </span>
              </p>
              <p className="mt-0.5 text-caption tabular-nums text-label-2">
                {formatExercise(exercise)}
              </p>
              {exercise.note ? (
                <p className="mt-1 text-caption leading-relaxed text-label-3">{exercise.note}</p>
              ) : null}
            </div>
          </li>
        ))}
      </ol>
      <p className="mt-2.5 border-t border-line pt-2 text-caption tabular-nums text-label-3">
        <span className="text-label-2">Total</span> {strengthSummary(p.exercises)}
      </p>
    </Card>
  )
}

/**
 * A Fuerza day with no exercises on it, which — unlike an undescribed run — is a session
 * nobody can actually do. So the way out is the library rather than the plan editor.
 */
function StrengthEmpty() {
  return (
    <Card className="fade-up">
      <CardTitle>Ejercicios</CardTitle>
      <EmptyState
        action={
          <TextLink href="/plantillas" tone="primary">
            Ver las plantillas
          </TextLink>
        }
      >
        Esta sesión todavía no lleva ejercicios. Aplícale una plantilla desde el editor de la
        sesión, en el plan.
      </EmptyState>
    </Card>
  )
}

/** One entry per kind. A kind added to `Prescriptions` and not to this is a build error. */
export const PRESCRIPTION_VIEWS: { [K in PrescriptionKind]: PrescriptionView<K> } = {
  run: { Line: WorkoutLine, Breakdown: StepList, Detail: Workout, Empty: WorkoutEmpty },
  strength: {
    Line: StrengthLine,
    Breakdown: StrengthList,
    Detail: StrengthDetail,
    Empty: StrengthEmpty,
  },
}
