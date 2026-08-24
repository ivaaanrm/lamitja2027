import { useEffect, useRef, useState } from 'react'
import { formatPace, parsePace } from '@/lib/activity'
import { cn } from '@/lib/cn'
import { ApiError, createSession, deleteSession, updateSession } from '@/lib/plan-client'
import { SESSION_META, SESSION_TYPES, weekDays } from '@/lib/plan'
import { formatStep } from '@/lib/workout'
import type { PlanSession } from '@/lib/db/schema'
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

/** What the keyboard leaves of the screen: how tall it still is, and how much of the
 *  bottom edge is covered. Null until the first measurement, and on any browser without
 *  a `visualViewport`. */
interface Viewport {
  height: number
  inset: number
}

/**
 * Create/edit sheet for one session. Entered in the units a runner thinks in — kilometres,
 * minutes, `m:ss` per km — and converted to the metres and seconds everything else stores
 * at the boundary, so no display unit ever reaches the database.
 *
 * This is the app's only modal, so it is where the sheet-rise energy is spent: the panel
 * travels its own height up from the bottom edge, the scrim fades in behind it, and the
 * two are separate elements precisely so the scrim never travels with it.
 *
 * The layout is three bands — a pinned grabber and title, a scrolling body, and a pinned
 * action bar. The bar is pinned rather than sitting at the end of the form because a
 * sheet whose Guardar button is below the fold is a sheet that looks like it cannot be
 * saved, and on a phone the fold moves every time the keyboard opens.
 */
export function SessionForm({
  weekIndex,
  session,
  defaultDay,
  onSaved,
  onClose,
}: {
  weekIndex: number
  session?: PlanSession
  defaultDay?: number
  onSaved: () => Promise<void> | void
  onClose: () => void
}) {
  const [draft, setDraft] = useState<Draft>(() =>
    session ? fromSession(session) : blank(defaultDay ?? weekDays(weekIndex)[0]!),
  )
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // A destructive action one thumb-slip from the primary one needs a second tap, not a
  // confirm dialog on top of a sheet.
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const [viewport, setViewport] = useState<Viewport | null>(null)
  const panelRef = useRef<HTMLDivElement>(null)

  /**
   * iOS does not shrink the layout viewport when the keyboard comes up: `100vh`, `100dvh`
   * and a `fixed inset-0` scrim all keep describing the whole screen, so a sheet anchored
   * to the bottom edge keeps its action bar under the keys. `visualViewport` is the only
   * surface that reports the covered strip, so the panel is lifted clear of it and capped
   * to whatever height is left.
   *
   * Read in an effect and never in the component body: this island is also rendered during
   * prerender, inside a Worker where there is no `window` at all (AGENTS gotcha 15).
   */
  useEffect(() => {
    const vv = window.visualViewport
    if (!vv) return
    const measure = () =>
      setViewport({
        height: vv.height,
        inset: Math.max(0, window.innerHeight - vv.height - vv.offsetTop),
      })
    measure()
    vv.addEventListener('resize', measure)
    vv.addEventListener('scroll', measure)
    return () => {
      vv.removeEventListener('resize', measure)
      vv.removeEventListener('scroll', measure)
    }
  }, [])

  useEffect(() => {
    // Focus goes to the panel, not to the first field: an autofocused input opens the
    // keyboard before anyone has decided to type, and the sheet would arrive with half of
    // itself already covered. It also puts Escape and the tab order inside the dialog.
    panelRef.current?.focus()
  }, [])

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) =>
    setDraft((current) => ({ ...current, [key]: value }))

  // The designed workout and the summary fields describe the same session, so they can
  // disagree. Editing a number by hand drops the breakdown rather than leaving a stale
  // one behind it; re-seeding the plan puts it back.
  const original = session ? fromSession(session) : null
  const prescriptionEdited =
    original != null &&
    (draft.distanceKm !== original.distanceKm ||
      draft.durationMin !== original.durationMin ||
      draft.paceLo !== original.paceLo ||
      draft.paceHi !== original.paceHi)

  const number = (value: string, scale = 1) => {
    const trimmed = value.trim()
    if (trimmed === '') return null
    const parsed = Number(trimmed)
    return Number.isFinite(parsed) && parsed > 0 ? parsed * scale : null
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
        ...(prescriptionEdited ? { steps: null } : {}),
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

  // With the keyboard down the sheet leaves a strip of scrim above it — that strip is the
  // tap target that dismisses it. With the keyboard up every remaining pixel is worth more
  // than the strip, so the cap opens out to the whole visible viewport.
  const maxHeight = viewport
    ? Math.round(viewport.height * (viewport.inset > 0 ? 1 : 0.88))
    : undefined

  return (
    <div
      className="fixed inset-0 z-50"
      role="dialog"
      aria-modal="true"
      aria-labelledby="session-form-title"
      onKeyDown={(event) => {
        if (event.key === 'Escape' && !busy) onClose()
      }}
    >
      <button
        type="button"
        aria-label="Cerrar"
        onClick={() => !busy && onClose()}
        className="fade-in absolute inset-0 bg-surface-deep/80 backdrop-blur-sm"
      />

      <div
        className="absolute inset-x-0 bottom-0 flex justify-center"
        style={{ bottom: viewport?.inset ?? 0 }}
      >
        <div
          ref={panelRef}
          tabIndex={-1}
          aria-busy={busy}
          style={{ maxHeight }}
          className="sheet-rise performance-shadow flex max-h-[88dvh] w-full max-w-lg flex-col overflow-hidden rounded-t-2xl border-t border-line bg-surface-raised outline-none"
        >
          {/* The inset is 20px rather than the 12px a card uses, so the controls sit where
              a card's contents sit optically: the page gutter is not under a sheet. */}
          <div className="shrink-0 px-5 pb-2.5 pt-2.5">
            <span aria-hidden className="mx-auto mb-3 block h-1 w-10 rounded-full bg-fill-strong" />
            <h2 id="session-form-title" className="font-display text-title3 font-bold tracking-tight">
              {session ? 'Editar sesión' : 'Nueva sesión'}
            </h2>
          </div>

          <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-5 pb-4">
            <Field label="Día">
              <Select value={draft.scheduledOn} onChange={(e) => set('scheduledOn', e.target.value)}>
                {weekDays(weekIndex).map((day) => (
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

            {session?.steps?.length ? (
              <div className="rounded-xl border border-line bg-surface-deep/30 px-3 py-2.5">
                <p className="text-caption2 font-semibold uppercase tracking-[0.12em] text-label-3">
                  Entrenamiento
                </p>
                <ol className="mt-2 space-y-1">
                  {session.steps.map((step, i) => (
                    <li key={i} className="text-caption leading-relaxed tabular-nums text-label-2">
                      {formatStep(step)}
                    </li>
                  ))}
                </ol>
                <p className={cn('mt-2 text-caption2 leading-relaxed', prescriptionEdited ? 'text-amber' : 'text-label-3')}>
                  {prescriptionEdited
                    ? 'Al guardar, este desglose se sustituye por los valores de arriba.'
                    : 'Viene del plan. Cambiar aquí una distancia o un ritmo lo sustituye.'}
                </p>
              </div>
            ) : null}

            {/* Coaching prose only — the repetitions live in the steps above, where they
                can be counted. */}
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
          </div>

          <div className="shrink-0 border-t border-line px-5 pb-[calc(0.75rem+env(safe-area-inset-bottom))] pt-3">
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
          </div>
        </div>
      </div>
    </div>
  )
}
