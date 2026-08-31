import { useState } from 'react'
import { cn } from '@/lib/cn'
import type { WorkoutTemplate } from '@/lib/db/schema'
import {
  ApiError,
  createTemplate,
  deleteTemplate,
  updateTemplate,
} from '@/lib/plan-client'
import { builtInTemplate, isBuiltInTemplateId, type TemplateContent } from '@/lib/starters'
import { formatExercise, strengthSummary, type StrengthExercise } from '@/lib/strength'
import { ExerciseThumb, RepdbAttribution } from './exercise-ui'
import { ExercisePicker } from './ExercisePicker'
import { island } from './Island'
import { navigate, useRouteParams, type Route } from './router'
import { useBlock } from './useBlock'
import {
  CHEVRON_LEFT,
  PLUS,
  ActionLink,
  Button,
  Card,
  CardTitle,
  Chip,
  EmptyState,
  ErrorCard,
  Field,
  LoadingCard,
  Segmented,
  TextArea,
  TextInput,
  TextLink,
} from './ui'

/**
 * One template, written or read — the screen `/plantillas` opens on.
 *
 * A screen rather than a sheet, and that follows from what is in it: this one opens a
 * sheet of its own (the exercise picker), and a sheet over a sheet on a 375px phone is two
 * scrims, two scroll containers and a keyboard that belongs to neither.
 *
 * Two shapes share the layout. The athlete's own templates are a form. The two that ship
 * with the app render read-only with a **Duplicar** button instead, because a built-in has
 * no row to patch: it is compiled into the bundle, identical for everybody, and the API
 * refuses the `treximo-` namespace outright. Duplicating writes a copy under a new id,
 * which is the only honest way to "edit" something that is not yours.
 *
 * The id is in the query string and read through `useRouteParams`, so the tri-state is the
 * same one `/sesion` documents: `undefined` while the prerendered shell hydrates, `null`
 * for a new template, a string for an existing one. `key` on the inner form is what makes
 * the draft belong to *this* template — opening another one from the library is a new
 * form, not the old one's state under a different name.
 */
function TemplateEditorScreen({ route }: { route: Route }) {
  const { data, error, reload } = useBlock()
  const params = useRouteParams(route)
  const id: string | null | undefined = params ? params.get('id') : undefined

  if (error && !data)
    return <ErrorCard title="Sin datos del bloque" message={error} onRetry={() => void reload()} />
  if (!data || id === undefined) return <LoadingCard rows={4} />

  const builtIn = id !== null && isBuiltInTemplateId(id) ? builtInTemplate(id) : undefined
  if (builtIn) return <BuiltInTemplate template={builtIn} onReload={reload} />

  const own: WorkoutTemplate | undefined = id === null
    ? undefined
    : data.templates.find((template) => template.id === id)

  if (id !== null && !own) {
    return (
      <Card className="fade-up">
        <BackLink />
        <CardTitle>Plantilla</CardTitle>
        <EmptyState action={<TextLink href="/plantillas">Volver a Plantillas</TextLink>}>
          Esa plantilla ya no existe. Puede que la hayas borrado desde otro dispositivo.
        </EmptyState>
      </Card>
    )
  }

  return <TemplateForm key={id ?? 'nueva'} template={own ?? null} onSaved={reload} />
}

function BackLink() {
  return (
    <div className="-mx-1 -mt-1.5 mb-1">
      <ActionLink icon={CHEVRON_LEFT} href="/plantillas">
        Plantillas
      </ActionLink>
    </div>
  )
}

// ---------------------------------------------------------------------------
// The draft
//
// The exercises are held as *strings* rather than as `StrengthExercise` values, and that is
// what makes the form usable: a numeric field being cleared on the way to another number is
// an empty string for a keystroke or two, and a draft typed as numbers has to answer "what
// is `sets` right now" with `NaN` every time. So the conversion happens once, at save, the
// same way kilometres become metres in `SessionForm`.
// ---------------------------------------------------------------------------

interface ExerciseDraft {
  exerciseId: string | null
  name: string
  sets: string
  /** Which of the two amounts this move is measured in — a plank has no repetitions. */
  measure: 'reps' | 'time'
  amount: string
  perSide: boolean
  restS: string
  load: string
  note: string
}

const toDraft = (exercise: StrengthExercise): ExerciseDraft => ({
  exerciseId: exercise.exerciseId,
  name: exercise.name,
  sets: String(exercise.sets),
  measure: exercise.durationS != null ? 'time' : 'reps',
  amount: String(exercise.durationS ?? exercise.reps ?? ''),
  perSide: exercise.perSide,
  restS: exercise.restS == null ? '' : String(exercise.restS),
  load: exercise.load ?? '',
  note: exercise.note ?? '',
})

/** A positive integer, or `null` for anything a field can hold that is not one. */
const count = (value: string): number | null => {
  const parsed = Number(value.trim())
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null
}

const toExercise = (draft: ExerciseDraft): StrengthExercise => {
  const amount = count(draft.amount)
  return {
    exerciseId: draft.exerciseId,
    name: draft.name.trim(),
    // The field can be empty mid-edit; one series is the floor the schema states anyway.
    sets: count(draft.sets) ?? 1,
    reps: draft.measure === 'reps' ? amount : null,
    durationS: draft.measure === 'time' ? amount : null,
    perSide: draft.perSide,
    // 0 is a real answer here — «seguido» — so it is not folded into null.
    restS: draft.restS.trim() === '' ? null : (Number(draft.restS) || 0),
    load: draft.load.trim() || null,
    note: draft.note.trim() || null,
  }
}

function TemplateForm({
  template,
  onSaved,
}: {
  /** `null` for a new one. */
  template: WorkoutTemplate | null
  onSaved: () => Promise<void>
}) {
  const [name, setName] = useState(template?.name ?? '')
  const [notes, setNotes] = useState(template?.notes ?? '')
  const [durationMin, setDurationMin] = useState(
    template?.targetDurationS == null ? '' : String(Math.round(template.targetDurationS / 60)),
  )
  const [exercises, setExercises] = useState<ExerciseDraft[]>(
    () => (template?.exercises ?? []).map(toDraft),
  )
  const [picking, setPicking] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirmingDelete, setConfirmingDelete] = useState(false)

  const set = (index: number, patch: Partial<ExerciseDraft>) =>
    setExercises((current) =>
      current.map((draft, i) => (i === index ? { ...draft, ...patch } : draft)),
    )

  const move = (index: number, by: -1 | 1) =>
    setExercises((current) => {
      const to = index + by
      if (to < 0 || to >= current.length) return current
      const next = [...current]
      const [lifted] = next.splice(index, 1)
      next.splice(to, 0, lifted!)
      return next
    })

  async function save() {
    const trimmed = name.trim()
    if (!trimmed) return setError('Ponle un nombre a la plantilla.')
    if (exercises.length === 0) return setError('Una plantilla necesita al menos un ejercicio.')

    setBusy(true)
    setError(null)
    try {
      const payload = {
        name: trimmed,
        notes: notes.trim() || null,
        targetDurationS: count(durationMin) === null ? null : count(durationMin)! * 60,
        exercises: exercises.map(toExercise),
      }
      if (template) await updateTemplate(template.id, payload)
      else await createTemplate(payload)
      await onSaved()
      navigate('/plantillas')
    } catch (cause) {
      // The server's issues name the offending index, which is the half a bare message
      // loses — «El ejercicio 4» is what tells you which row to open.
      const issues = cause instanceof ApiError ? cause.issues : []
      setError(
        [cause instanceof Error ? cause.message : 'No se pudo guardar', ...issues.map((i) => i.message)]
          .join(' · '),
      )
      setBusy(false)
    }
  }

  async function remove() {
    if (!template) return
    setBusy(true)
    setError(null)
    try {
      await deleteTemplate(template.id)
      await onSaved()
      navigate('/plantillas')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'No se pudo borrar')
      setBusy(false)
    }
  }

  return (
    <>
      <Card className="fade-up">
        <BackLink />
        <div className="space-y-3">
          <Field label="Nombre">
            <TextInput
              value={name}
              placeholder="Fuerza de lunes"
              onChange={(event) => setName(event.target.value)}
            />
          </Field>
          <Field label="Notas">
            <TextArea
              rows={3}
              value={notes}
              placeholder="Cuándo progresar, qué señales respetar."
              onChange={(event) => setNotes(event.target.value)}
            />
          </Field>
          <Field label="Duración prevista (min)">
            <TextInput
              inputMode="numeric"
              value={durationMin}
              placeholder="35"
              onChange={(event) => setDurationMin(event.target.value)}
            />
          </Field>
        </div>
      </Card>

      <Card className="fade-up">
        <CardTitle
          action={
            <TextLink inset onClick={() => setPicking(true)}>
              Añadir
            </TextLink>
          }
        >
          Ejercicios
        </CardTitle>

        {exercises.length === 0 ? (
          <EmptyState
            action={
              <Button variant="primary" onClick={() => setPicking(true)}>
                Buscar en el catálogo
              </Button>
            }
          >
            Todavía no hay ningún ejercicio. Búscalos por nombre, por músculo o por
            material — o filtra por los que son aptos para la rodilla.
          </EmptyState>
        ) : (
          <>
            <ol className="divide-y divide-line">
              {exercises.map((draft, i) => (
                <ExerciseRow
                  key={`${draft.exerciseId ?? 'libre'}-${i}`}
                  draft={draft}
                  index={i}
                  last={i === exercises.length - 1}
                  onChange={(patch) => set(i, patch)}
                  onMove={(by) => move(i, by)}
                  onRemove={() =>
                    setExercises((current) => current.filter((_, at) => at !== i))
                  }
                />
              ))}
            </ol>
            <p className="mt-2 border-t border-line pt-2 text-caption tabular-nums text-label-3">
              <span className="text-label-2">Total</span>{' '}
              {strengthSummary(
                exercises.map(toExercise),
                count(durationMin) === null ? null : count(durationMin)! * 60,
              )}
            </p>
          </>
        )}
        <RepdbAttribution className="mt-2.5 px-0" />
      </Card>

      {error ? (
        <p role="alert" className="px-1 text-caption leading-relaxed text-red">
          {error}
        </p>
      ) : null}

      <div className="flex gap-2">
        <Button className="flex-1" href="/plantillas">
          Cancelar
        </Button>
        <Button variant="primary" className="flex-[2]" disabled={busy} onClick={() => void save()}>
          {busy ? 'Guardando…' : 'Guardar'}
        </Button>
      </div>

      {template ? (
        <div className="px-1">
          <Button
            variant="danger"
            className="w-full"
            disabled={busy}
            onClick={() => (confirmingDelete ? void remove() : setConfirmingDelete(true))}
          >
            {confirmingDelete ? 'Confirmar borrado' : 'Borrar plantilla'}
          </Button>
          {confirmingDelete ? (
            <p className="mt-1.5 text-caption leading-relaxed text-label-3">
              Se borra de tu biblioteca. Las sesiones que ya la llevan aplicada no se tocan:
              cada una guarda su propia copia.
            </p>
          ) : null}
        </div>
      ) : null}

      {picking ? (
        <ExercisePicker
          onClose={() => setPicking(false)}
          onPick={(exercise) => {
            setExercises((current) => [...current, toDraft(exercise)])
            setPicking(false)
          }}
        />
      ) : null}
    </>
  )
}

/**
 * One exercise, collapsed to what it prescribes and unfolding to how it is edited.
 *
 * Collapsed by default because a template runs to nine moves and eight fields each: open,
 * that is a form several thousand pixels long, which is a form nobody scrolls to the
 * bottom of. Closed, the row says exactly what the athlete will read on the mat — the
 * illustration, the name and `formatExercise` — so the list reads as the prescription it
 * is rather than as a settings screen.
 *
 * Reorder and delete live inside the open row rather than beside the chevron. Three 44px
 * targets in one 375px header is two of them overlapping, and the one that loses is
 * whichever paints first.
 */
function ExerciseRow({
  draft,
  index,
  last,
  onChange,
  onMove,
  onRemove,
}: {
  draft: ExerciseDraft
  index: number
  last: boolean
  onChange: (patch: Partial<ExerciseDraft>) => void
  onMove: (by: -1 | 1) => void
  onRemove: () => void
}) {
  const [open, setOpen] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const exercise = toExercise(draft)

  return (
    <li>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className="tappable flex w-full min-h-11 items-center gap-2.5 py-2 text-left"
      >
        <ExerciseThumb exerciseId={draft.exerciseId} className="size-11" />
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-baseline gap-1.5">
            <span aria-hidden className="shrink-0 text-caption2 tabular-nums text-label-4">
              {index + 1}
            </span>
            <span className="text-footnote font-medium leading-snug text-label">{draft.name}</span>
          </span>
          <span className="mt-0.5 block text-caption tabular-nums text-label-3">
            {formatExercise(exercise)}
          </span>
        </span>
      </button>

      {open ? (
        <div className="fade-up space-y-2.5 pb-3">
          <Segmented
            label="Cómo se mide"
            value={draft.measure}
            onChange={(measure) => onChange({ measure })}
            options={[
              { value: 'reps', label: 'Repeticiones' },
              { value: 'time', label: 'Segundos' },
            ]}
          />

          <div className="grid grid-cols-2 gap-2">
            <Field label="Series">
              <TextInput
                inputMode="numeric"
                value={draft.sets}
                placeholder="3"
                onChange={(event) => onChange({ sets: event.target.value })}
              />
            </Field>
            <Field label={draft.measure === 'reps' ? 'Repeticiones' : 'Segundos'}>
              <TextInput
                inputMode="numeric"
                value={draft.amount}
                placeholder={draft.measure === 'reps' ? '10' : '30'}
                onChange={(event) => onChange({ amount: event.target.value })}
              />
            </Field>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <Field label="Descanso (s)">
              <TextInput
                inputMode="numeric"
                value={draft.restS}
                placeholder="60"
                onChange={(event) => onChange({ restS: event.target.value })}
              />
            </Field>
            <Field label="Carga">
              <TextInput
                value={draft.load}
                placeholder="sin peso"
                onChange={(event) => onChange({ load: event.target.value })}
              />
            </Field>
          </div>

          <Field label="Nota">
            <TextInput
              value={draft.note}
              placeholder="Qué sentir, en qué pararte."
              onChange={(event) => onChange({ note: event.target.value })}
            />
          </Field>

          <button
            type="button"
            aria-pressed={draft.perSide}
            onClick={() => onChange({ perSide: !draft.perSide })}
            className={cn(
              'tappable inline-flex min-h-11 items-center rounded-full px-3 text-caption font-medium',
              draft.perSide ? 'bg-accent text-surface' : 'bg-fill text-label-2',
            )}
          >
            Por lado
          </button>

          <div className="flex flex-wrap items-center gap-x-4">
            <TextLink disabled={index === 0} onClick={() => onMove(-1)}>
              Subir
            </TextLink>
            <TextLink disabled={last} onClick={() => onMove(1)}>
              Bajar
            </TextLink>
            <TextLink
              className="text-red"
              onClick={() => (confirming ? onRemove() : setConfirming(true))}
            >
              {confirming ? 'Confirmar' : 'Quitar'}
            </TextLink>
          </div>
        </div>
      ) : null}
    </li>
  )
}

/**
 * A built-in, read-only, with the one action that makes sense on it.
 *
 * The `treximo-` namespace never has a row: these two are compiled into the bundle and are
 * the same content for every athlete, so `create_template`, `update_template` and
 * `delete_template` all refuse the prefix outright. That refusal is the honest one — an
 * editable built-in would be a per-athlete copy shadowing a shared one, which is exactly
 * the drift a template library is supposed to remove — so the screen offers a duplicate
 * instead, and the duplicate is yours from the moment it lands.
 */
function BuiltInTemplate({
  template,
  onReload,
}: {
  template: TemplateContent
  onReload: () => Promise<void>
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function duplicate() {
    setBusy(true)
    setError(null)
    try {
      const copy = await createTemplate({
        name: `${template.name} (copia)`,
        notes: template.notes,
        targetDurationS: template.targetDurationS,
        exercises: template.exercises,
      })
      await onReload()
      navigate(`/plantilla?id=${encodeURIComponent(copy.id)}`)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'No se pudo duplicar')
      setBusy(false)
    }
  }

  return (
    <>
      <Card className="fade-up">
        <BackLink />
        <div className="flex flex-wrap items-center gap-1.5">
          <Chip>De Treximo</Chip>
        </div>
        <h2 className="mt-1.5 font-display text-title3 font-bold leading-tight tracking-tight text-label">
          {template.name}
        </h2>
        <p className="mt-1 text-caption tabular-nums text-label-3">
          {strengthSummary(template.exercises, template.targetDurationS)}
        </p>
        {template.notes ? (
          <p className="mt-2 text-footnote leading-relaxed text-label-2">{template.notes}</p>
        ) : null}
        <p className="mt-2.5 text-caption leading-relaxed text-label-3">
          Es una plantilla de Treximo: viene con la app y es igual para todo el mundo, así
          que no se edita. Duplícala para hacerla tuya.
        </p>
        <Button
          variant="primary"
          className="mt-3 w-full"
          disabled={busy}
          onClick={() => void duplicate()}
        >
          {busy ? 'Duplicando…' : 'Duplicar'}
        </Button>
        {error ? (
          <p role="alert" className="mt-2 text-caption leading-relaxed text-red">
            {error}
          </p>
        ) : null}
      </Card>

      <Card className="fade-up">
        <CardTitle>Ejercicios</CardTitle>
        <ol className="space-y-3">
          {template.exercises.map((exercise, i) => (
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
        <RepdbAttribution className="mt-2.5 px-0" />
      </Card>

      <div className="px-1">
        <ActionLink icon={PLUS} href="/plantilla" tone="primary" inset>
          Escribir una desde cero
        </ActionLink>
      </div>
    </>
  )
}

/**
 * Wrapped so a render that throws leaves a card with a way out on it rather than an empty
 * column under the heading. See `Island.tsx`.
 */
export const TemplateEditor = island(TemplateEditorScreen)
