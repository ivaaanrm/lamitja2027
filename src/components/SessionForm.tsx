import { useState } from 'react'
import { formatPace, parsePace } from '@/lib/activity'
import { goalPaceSKm, weekDays, type BlockConfig } from '@/lib/block'
import { cn } from '@/lib/cn'
import { ApiError, createSession, deleteSession, updateSession } from '@/lib/plan-client'
import { SESSION_META, SESSION_TYPES } from '@/lib/plan'
import { paceBands } from '@/lib/paces'
import { STRATEGIES, prescriptionOf, runSteps } from '@/lib/prescription'
import { BUILTIN_TEMPLATES, sessionFromTemplate } from '@/lib/starters'
import type { StrengthPrescription } from '@/lib/strength'
import type { PlanSession, WorkoutTemplate } from '@/lib/db/schema'
import { Sheet } from './Sheet'
import { Button, Field, Select, TextArea, TextInput } from './ui'

const dayFmt = new Intl.DateTimeFormat('es-ES', {
  weekday: 'long',
  day: 'numeric',
  month: 'short',
  timeZone: 'UTC',
})

interface Draft {
  scheduledOn: string
  type: string
  title: string
  notes: string
  distanceKm: string
  durationMin: string
  paceLo: string
  paceHi: string
}

const blank = (scheduledOn: number): Draft => ({
  scheduledOn: String(scheduledOn),
  type: 'easy',
  title: '',
  notes: '',
  distanceKm: '',
  durationMin: '',
  paceLo: '',
  paceHi: '',
})

const fromSession = (session: PlanSession): Draft => ({
  scheduledOn: String(session.scheduledOn),
  type: session.type,
  title: session.title,
  notes: session.notes ?? '',
  // Prescribed distances are exact metres (a rep session lands on 12 364 m); a form is
  // not the place to make someone read that.
  distanceKm: session.targetDistanceM == null ? '' : String(Math.round(session.targetDistanceM / 10) / 100),
  durationMin: session.targetDurationS == null ? '' : String(Math.round(session.targetDurationS / 60)),
  paceLo: session.targetPaceLoSKm == null ? '' : formatPace(session.targetPaceLoSKm),
  paceHi: session.targetPaceHiSKm == null ? '' : formatPace(session.targetPaceHiSKm),
})

/**
 * Create/edit sheet for one session. Entered in the units a runner thinks in — kilometres,
 * minutes, `m:ss` per km — and converted to the metres and seconds everything else stores
 * at the boundary, so no display unit ever reaches the database.
 *
 * The modal chrome — the rise, the three bands, the keyboard fix — lives in `Sheet.tsx`
 * now, shared with the exercise picker. It was written out here first, back when this was
 * the app's only modal.
 *
 * **A Fuerza day is prescribed by picking, not by typing.** The one field below that is
 * not a number is «Plantilla», and choosing one stages a *copy* of its exercises onto this
 * session, with the title, the notes and the duration that come with it. That is the whole
 * write path for a strength prescription from the UI, and it is deliberately not an
 * exercise editor: nine moves belong on a screen (`/plantilla`), and a session is where
 * one gets stamped rather than where it gets designed.
 */
export function SessionForm({
  block,
  weekIndex,
  session,
  defaultDay,
  templates,
  onSaved,
  onClose,
}: {
  block: BlockConfig
  weekIndex: number
  session?: PlanSession
  defaultDay?: number
  /** The athlete's own library. The two built-ins are merged in below, from the bundle. */
  templates: WorkoutTemplate[]
  onSaved: () => Promise<void> | void
  onClose: () => void
}) {
  const [draft, setDraft] = useState<Draft>(() =>
    session ? fromSession(session) : blank(defaultDay ?? weekDays(block, weekIndex)[0]!),
  )
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // A destructive action one thumb-slip from the primary one needs a second tap, not a
  // confirm dialog on top of a sheet.
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  /**
   * The template chosen in this sheet, and the copy of its exercises waiting to be saved.
   *
   * Held apart from `draft` because it is not a *field*: it is a payload the save sends
   * whole, while the fields it filled in (título, notas, duración) stay editable after it
   * lands. The empty string is «ninguna», which is also the state a session that already
   * carries exercises opens in — the Select offers to *replace*, and never claims to
   * describe what is already there.
   */
  const [templateId, setTemplateId] = useState('')
  const [staged, setStaged] = useState<StrengthPrescription | null>(null)

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) =>
    setDraft((current) => ({ ...current, [key]: value }))

  // The designed workout and the summary fields describe the same session, so they can
  // disagree. Editing a number by hand drops the breakdown rather than leaving a stale
  // one behind it; re-seeding the plan puts it back.
  const original = session ? fromSession(session) : null
  const numbersEdited =
    original != null &&
    (draft.distanceKm !== original.distanceKm ||
      draft.durationMin !== original.durationMin ||
      draft.paceLo !== original.paceLo ||
      draft.paceHi !== original.paceHi)
  /**
   * …and the drop applies to a *run* breakdown alone.
   *
   * Steps derive the session's distance, so editing that distance by hand contradicts
   * them. A strength payload derives nothing — the minutes are stated on the session row —
   * so nothing about it disagrees with a number typed above it, and wiping nine prescribed
   * moves because somebody corrected the duration would be the editor deleting a session's
   * whole content as a side effect.
   */
  const prescriptionEdited = numbersEdited && runSteps(session?.steps) !== null

  const number = (value: string, scale = 1) => {
    const trimmed = value.trim()
    if (trimmed === '') return null
    const parsed = Number(trimmed)
    return Number.isFinite(parsed) && parsed > 0 ? parsed * scale : null
  }

  /**
   * The library, own rows first, and only for the two types a template can describe. A
   * rodaje has no exercises, and a «Plantilla» field over a run would be an affordance for
   * something the app then refuses to do.
   */
  const applicable =
    draft.type === 'strength' || draft.type === 'cross' ? [...templates, ...BUILTIN_TEMPLATES] : []

  /**
   * Stamping one onto this session: a copy, right down to clearing the distance.
   *
   * `sessionFromTemplate` is shared with the MCP `attach_template` tool, so a session
   * stamped by an agent is the same session stamped by a thumb. The título is only filled
   * where there is nothing worth keeping — an empty field, or the name the last template
   * put there — because a title somebody typed is the one thing on this sheet a template
   * has no business overwriting.
   */
  function applyTemplate(id: string) {
    setTemplateId(id)
    const chosen = applicable.find((template) => template.id === id)
    if (!chosen) {
      setStaged(null)
      return
    }

    const copy = sessionFromTemplate(chosen)
    const untouched =
      draft.title.trim() === '' || applicable.some((t) => t.name === draft.title.trim())

    setStaged(copy.steps)
    setDraft((current) => ({
      ...current,
      title: untouched ? copy.title : current.title,
      notes: copy.notes ?? '',
      durationMin: copy.targetDurationS == null ? '' : String(Math.round(copy.targetDurationS / 60)),
      // The copy is total: a run's metres must not be left sitting under a list of planks.
      distanceKm: '',
    }))
  }

  async function save() {
    setBusy(true)
    setError(null)
    try {
      // Paces are the one field where a typo is silent, so a malformed value is rejected
      // here rather than quietly saved as "no target".
      for (const [label, value] of [
        ['El ritmo más rápido', draft.paceLo],
        ['El ritmo más lento', draft.paceHi],
      ] as const) {
        if (value.trim() !== '' && parsePace(value) === null) {
          throw new ApiError(`${label} tiene que ir en formato 3:47`)
        }
      }

      const payload = {
        scheduledOn: Number(draft.scheduledOn),
        type: draft.type as (typeof SESSION_TYPES)[number],
        title: draft.title.trim() || SESSION_META[draft.type as (typeof SESSION_TYPES)[number]].label,
        notes: draft.notes.trim() || null,
        targetDistanceM: number(draft.distanceKm, 1000),
        targetDurationS: number(draft.durationMin, 60),
        targetPaceLoSKm: draft.paceLo.trim() === '' ? null : parsePace(draft.paceLo),
        targetPaceHiSKm: draft.paceHi.trim() === '' ? null : parsePace(draft.paceHi),
        // A staged template always wins over the drop rule: it is the one control in this
        // sheet that is explicitly *about* replacing the prescription.
        ...(staged ? { steps: staged } : prescriptionEdited ? { steps: null } : {}),
      }

      if (session) await updateSession(session.id, payload)
      else await createSession(payload)

      await onSaved()
      onClose()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'No se pudo guardar')
    } finally {
      setBusy(false)
    }
  }

  async function remove() {
    if (!session) return
    setBusy(true)
    setError(null)
    try {
      await deleteSession(session.id)
      await onSaved()
      onClose()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'No se pudo borrar')
      setBusy(false)
    }
  }

  return (
    <Sheet
      title={session ? 'Editar sesión' : 'Nueva sesión'}
      busy={busy}
      onClose={onClose}
      footer={
        <>
          {error ? (
            <p role="alert" className="mb-2 text-caption leading-relaxed text-red">
              {error}
            </p>
          ) : null}
          <div className="flex gap-2">
            <Button className="flex-1" onClick={onClose} disabled={busy}>
              Cancelar
            </Button>
            <Button variant="primary" className="flex-[2]" disabled={busy} onClick={() => void save()}>
              {busy ? 'Guardando…' : 'Guardar'}
            </Button>
          </div>
        </>
      }
    >
      <Field label="Día">
        <Select value={draft.scheduledOn} onChange={(e) => set('scheduledOn', e.target.value)}>
          {weekDays(block, weekIndex).map((day) => (
            <option key={day} value={day}>
              {dayFmt.format(new Date(day))}
            </option>
          ))}
        </Select>
      </Field>

      <Field label="Tipo">
        <Select value={draft.type} onChange={(e) => set('type', e.target.value)}>
          {SESSION_TYPES.map((type) => (
            <option key={type} value={type}>
              {SESSION_META[type].label}
            </option>
          ))}
        </Select>
      </Field>

      <Field label="Título">
        <TextInput
          value={draft.title}
          placeholder={SESSION_META[draft.type as (typeof SESSION_TYPES)[number]].label}
          onChange={(e) => set('title', e.target.value)}
        />
      </Field>

      <div className="grid grid-cols-2 gap-2">
        <Field label="Distancia (km)">
          <TextInput
            inputMode="decimal"
            value={draft.distanceKm}
            placeholder="10"
            onChange={(e) => set('distanceKm', e.target.value)}
          />
        </Field>
        <Field label="Duración (min)">
          <TextInput
            inputMode="numeric"
            value={draft.durationMin}
            placeholder="45"
            onChange={(e) => set('durationMin', e.target.value)}
          />
        </Field>
      </div>

      {/* One field, two inputs: a pace target is a band, and "Ritmo desde" over one
          box and "Ritmo hasta" over another asked the reader to reassemble it. Not
          wrapped in `Field` because that renders a `<label>`, and a label owns
          exactly one control — each input carries its own name instead, worded the
          way the validation message below refers to it. */}
      <div>
        <span className="text-caption2 uppercase tracking-[0.09em] text-label-3">
          Ritmo objetivo (min/km)
        </span>
        <div className="mt-1 flex items-center gap-2">
          <TextInput
            aria-label="El ritmo más rápido"
            inputMode="numeric"
            value={draft.paceLo}
            placeholder="3:47"
            onChange={(e) => set('paceLo', e.target.value)}
          />
          <span aria-hidden className="text-footnote text-label-3">
            –
          </span>
          <TextInput
            aria-label="El ritmo más lento"
            inputMode="numeric"
            value={draft.paceHi}
            placeholder="4:05"
            onChange={(e) => set('paceHi', e.target.value)}
          />
        </div>
      </div>

      {applicable.length > 0 ? (
        <Field label="Plantilla">
          <Select value={templateId} onChange={(e) => applyTemplate(e.target.value)}>
            <option value="">— Ninguna —</option>
            {templates.length > 0 ? (
              <optgroup label="Tuyas">
                {templates.map((template) => (
                  <option key={template.id} value={template.id}>
                    {template.name}
                  </option>
                ))}
              </optgroup>
            ) : null}
            <optgroup label="De Treximo">
              {BUILTIN_TEMPLATES.map((template) => (
                <option key={template.id} value={template.id}>
                  {template.name}
                </option>
              ))}
            </optgroup>
          </Select>
          <p className="mt-1 text-caption2 leading-relaxed text-label-3">
            Se copia en la sesión. Editar la plantilla después no cambia esta sesión.
          </p>
        </Field>
      ) : null}

      <Prescription block={block} staged={staged} session={session} willDrop={prescriptionEdited} />

      {/* Coaching prose only — the repetitions live in the prescription above, where
          they can be counted. */}
      <Field label="Notas">
        <TextArea
          rows={3}
          value={draft.notes}
          placeholder="Terreno, cadencia, cuándo abortar."
          onChange={(e) => set('notes', e.target.value)}
        />
      </Field>

      {session ? (
        <div className="pt-1">
          <Button
            variant="danger"
            className="w-full"
            disabled={busy}
            onClick={() => (confirmingDelete ? void remove() : setConfirmingDelete(true))}
          >
            {confirmingDelete ? 'Confirmar borrado' : 'Borrar sesión'}
          </Button>
          {confirmingDelete ? (
            <p className="mt-1.5 text-caption leading-relaxed text-label-3">
              Se borra del plan. Las salidas de Strava no se tocan.
            </p>
          ) : null}
        </div>
      ) : null}
    </Sheet>
  )
}

/**
 * What this session prescribes, read back inside the sheet that is about to change it.
 *
 * It dispatches on the payload's own kind rather than assuming steps, so a Fuerza day
 * shows its nine moves here and a rodaje shows its warm-up, its reps and its cool-down —
 * one line per unit either way, through the same registry the cards read. A template
 * chosen above takes precedence: it is what will be saved, so it is what the sheet shows.
 *
 * The line under it is the honest warning about the *run* case alone. Steps and the
 * distance field describe one session and can disagree, so editing the number by hand
 * replaces the breakdown — which is why the amber sentence and the drop are gated on
 * exactly the same condition.
 */
function Prescription({
  block,
  staged,
  session,
  willDrop,
}: {
  block: BlockConfig
  staged: StrengthPrescription | null
  session?: PlanSession
  willDrop: boolean
}) {
  const prescription = staged ?? prescriptionOf(session?.steps)
  if (!prescription) return null

  // The athlete's own bands, from their goal pace — the owner's table would print Ivan's
  // seconds under someone else's target.
  const lines = STRATEGIES[prescription.kind].lines(
    prescription as never,
    paceBands(goalPaceSKm(block)),
  )

  return (
    <div className="rounded-xl border border-line bg-surface-deep/30 px-3 py-2.5">
      <p className="text-caption2 font-semibold uppercase tracking-[0.12em] text-label-3">
        {prescription.kind === 'run' ? 'Entrenamiento' : 'Ejercicios'}
      </p>
      <ol className="mt-2 space-y-1">
        {lines.map((line, i) => (
          <li key={i} className="text-caption tabular-nums leading-relaxed text-label-2">
            {line}
          </li>
        ))}
      </ol>
      <p className={cn('mt-2 text-caption2 leading-relaxed', willDrop ? 'text-amber' : 'text-label-3')}>
        {staged
          ? 'Se guardará como una copia dentro de esta sesión.'
          : willDrop
            ? 'Al guardar, este desglose se sustituye por los valores de arriba.'
            : prescription.kind === 'run'
              ? 'Viene del plan. Cambiar aquí una distancia o un ritmo lo sustituye.'
              : 'Viene de una plantilla. Se cambia eligiendo otra, o desde Plantillas.'}
      </p>
    </div>
  )
}
