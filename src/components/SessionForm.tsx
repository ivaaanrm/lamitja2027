import { useState } from 'react'
import { formatPace, parsePace } from '@/lib/activity'
import { ApiError, createSession, deleteSession, updateSession } from '@/lib/plan-client'
import { SESSION_META, SESSION_TYPES, weekDays } from '@/lib/plan'
import type { PlanSession } from '@/lib/db/schema'
import { Button, Field, Select, TextArea, TextInput } from './ui'

const dayFmt = new Intl.DateTimeFormat('en-GB', {
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
  distanceKm: session.targetDistanceM == null ? '' : String(session.targetDistanceM / 1000),
  durationMin: session.targetDurationS == null ? '' : String(Math.round(session.targetDurationS / 60)),
  paceLo: session.targetPaceLoSKm == null ? '' : formatPace(session.targetPaceLoSKm),
  paceHi: session.targetPaceHiSKm == null ? '' : formatPace(session.targetPaceHiSKm),
})

/**
 * Create/edit sheet for one session. Entered in the units a runner thinks in — kilometres,
 * minutes, `m:ss` per km — and converted to the metres and seconds everything else stores
 * at the boundary, so no display unit ever reaches the database.
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
    session ? fromSession(session) : blank(defaultDay ?? weekDays(weekIndex)[0]),
  )
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) =>
    setDraft((current) => ({ ...current, [key]: value }))

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
        ['Faster pace', draft.paceLo],
        ['Slower pace', draft.paceHi],
      ] as const) {
        if (value.trim() !== '' && parsePace(value) === null) {
          throw new ApiError(`${label} must look like 3:47`)
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
      }

      if (session) await updateSession(session.id, payload)
      else await createSession(payload)

      await onSaved()
      onClose()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not save')
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
      setError(cause instanceof Error ? cause.message : 'Could not delete')
      setBusy(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex flex-col justify-end bg-neutral-950/80 backdrop-blur-sm">
      <button type="button" aria-label="Close" className="flex-1" onClick={onClose} />

      <div className="max-h-[85vh] overflow-y-auto rounded-t-3xl border-t border-neutral-800 bg-neutral-900 p-5 pb-[calc(1.25rem+env(safe-area-inset-bottom))]">
        <div className="mx-auto max-w-md space-y-4">
          <h2 className="text-sm font-medium">{session ? 'Edit session' : 'New session'}</h2>

          <Field label="Day">
            <Select value={draft.scheduledOn} onChange={(e) => set('scheduledOn', e.target.value)}>
              {weekDays(weekIndex).map((day) => (
                <option key={day} value={day}>
                  {dayFmt.format(new Date(day))}
                </option>
              ))}
            </Select>
          </Field>

          <Field label="Type">
            <Select value={draft.type} onChange={(e) => set('type', e.target.value)}>
              {SESSION_TYPES.map((type) => (
                <option key={type} value={type}>
                  {SESSION_META[type].label}
                </option>
              ))}
            </Select>
          </Field>

          <Field label="Title">
            <TextInput
              value={draft.title}
              placeholder={SESSION_META[draft.type as (typeof SESSION_TYPES)[number]].label}
              onChange={(e) => set('title', e.target.value)}
            />
          </Field>

          <div className="grid grid-cols-2 gap-3">
            <Field label="Distance (km)">
              <TextInput
                inputMode="decimal"
                value={draft.distanceKm}
                placeholder="10"
                onChange={(e) => set('distanceKm', e.target.value)}
              />
            </Field>
            <Field label="Duration (min)">
              <TextInput
                inputMode="numeric"
                value={draft.durationMin}
                placeholder="45"
                onChange={(e) => set('durationMin', e.target.value)}
              />
            </Field>
            <Field label="Pace from">
              <TextInput
                inputMode="numeric"
                value={draft.paceLo}
                placeholder="3:47"
                onChange={(e) => set('paceLo', e.target.value)}
              />
            </Field>
            <Field label="Pace to">
              <TextInput
                inputMode="numeric"
                value={draft.paceHi}
                placeholder="4:05"
                onChange={(e) => set('paceHi', e.target.value)}
              />
            </Field>
          </div>

          <Field label="Notes">
            <TextArea
              rows={3}
              value={draft.notes}
              placeholder="6×1000 @ 3:50, 90s jog"
              onChange={(e) => set('notes', e.target.value)}
            />
          </Field>

          {error ? <p className="text-xs text-red-400">{error}</p> : null}

          <div className="flex gap-2 pt-1">
            <Button variant="primary" className="flex-1" disabled={busy} onClick={() => void save()}>
              {busy ? 'Saving…' : 'Save'}
            </Button>
            <Button onClick={onClose} disabled={busy}>
              Cancel
            </Button>
            {session ? (
              <Button variant="danger" onClick={() => void remove()} disabled={busy}>
                Delete
              </Button>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  )
}
