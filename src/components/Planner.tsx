import { useState } from 'react'
import { cn } from '@/lib/cn'
import { decimal } from '@/lib/format'
import type { WeekMetrics } from '@/lib/metrics'
import { setDone, updateWeek } from '@/lib/plan-client'
import { weekDays, type MatchedSession, type WeekPlan } from '@/lib/plan'
import type { PlanSession } from '@/lib/db/schema'
import { SessionForm } from './SessionForm'
import { ExtraCard, SessionCard } from './SessionCard'
import { useBlock } from './useBlock'
import { Button, Card, Chip, Field, ProgressBar, TextInput } from './ui'

const rangeFmt = new Intl.DateTimeFormat('es-ES', { day: 'numeric', month: 'short', timeZone: 'UTC' })
const dayFmt = new Intl.DateTimeFormat('es-ES', { weekday: 'short', day: 'numeric', timeZone: 'UTC' })

/**
 * The whole 22-week block, one accordion row per week, opening on the current one.
 *
 * Every edit writes straight through and re-reads `/api/data`. With a block this small
 * that is a fast round trip, and it means the editor can never drift from what was saved
 * — which matters more here than the few hundred milliseconds an optimistic update saves.
 */
export function Planner() {
  const { data, error, reload, weeks, progress, currentWeek } = useBlock()
  const [open, setOpen] = useState<number | null>(null)
  const [editing, setEditing] = useState<{ weekIndex: number; day?: number; session?: PlanSession } | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)

  // Opens on the current week the first time real data arrives, and stays wherever the
  // athlete puts it after that.
  const expanded = open ?? currentWeek

  if (error && !data) {
    return (
      <Card>
        <p className="text-sm text-red">{error}</p>
      </Card>
    )
  }
  if (!data || !progress) {
    return (
      <Card>
        <p className="text-sm text-label-3">Cargando…</p>
      </Card>
    )
  }

  async function toggle(match: MatchedSession) {
    setActionError(null)
    try {
      await setDone(match.session.id, !match.done)
      await reload()
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : 'No se pudo guardar')
    }
  }

  return (
    <>
      <div className="space-y-2">
        {weeks.map((week) => (
          <WeekRow
            key={week.weekIndex}
            week={week}
            metrics={progress.weekly[week.weekIndex]}
            isCurrent={week.weekIndex === currentWeek}
            isOpen={week.weekIndex === expanded}
            onOpen={() => setOpen(week.weekIndex === expanded ? -1 : week.weekIndex)}
            onReload={reload}
            onToggle={toggle}
            onEdit={(session) => setEditing({ weekIndex: week.weekIndex, session })}
            onAdd={(day) => setEditing({ weekIndex: week.weekIndex, day })}
            onError={setActionError}
          />
        ))}
      </div>

      {actionError ? <p className="mt-4 text-center text-xs text-red">{actionError}</p> : null}

      {editing ? (
        <SessionForm
          weekIndex={editing.weekIndex}
          session={editing.session}
          defaultDay={editing.day}
          onSaved={reload}
          onClose={() => setEditing(null)}
        />
      ) : null}
    </>
  )
}

function WeekRow({
  week,
  metrics,
  isCurrent,
  isOpen,
  onOpen,
  onReload,
  onToggle,
  onEdit,
  onAdd,
  onError,
}: {
  week: WeekPlan
  metrics: WeekMetrics
  isCurrent: boolean
  isOpen: boolean
  onOpen: () => void
  onReload: () => Promise<void>
  onToggle: (match: MatchedSession) => void
  onEdit: (session: PlanSession) => void
  onAdd: (day: number) => void
  onError: (message: string | null) => void
}) {
  const days = weekDays(week.weekIndex)
  const km = metrics.totals.distanceM / 1000
  const targetKm = metrics.targetVolumeM == null ? null : metrics.targetVolumeM / 1000

  return (
    <Card className={cn('p-0', isCurrent && 'border-line-strong')}>
      <button
        type="button"
        onClick={onOpen}
        aria-expanded={isOpen}
        className="flex w-full items-center justify-between gap-3 p-4 text-left"
      >
        <span className="min-w-0">
          <span className="flex items-center gap-2">
            <span className="text-sm font-medium">S{week.weekIndex + 1}</span>
            <span className="text-xs text-label-3">
              {rangeFmt.format(new Date(days[0]))} – {rangeFmt.format(new Date(days[6]))}
            </span>
            {metrics.isDownWeek ? <Chip tone="down">Descarga</Chip> : null}
          </span>
          {metrics.phase ? (
            <span className="mt-1 block truncate text-xs text-label-3">{metrics.phase}</span>
          ) : null}
        </span>

        <span className="shrink-0 text-right">
          <span className="block text-sm tabular-nums">
            {decimal(km)}
            {targetKm != null ? (
              <span className="text-label-3"> / {targetKm.toFixed(0)}</span>
            ) : null}
            <span className="ml-1 text-xs text-label-3">km</span>
          </span>
          {metrics.sessionsPlanned > 0 ? (
            <span className="block text-xs tabular-nums text-label-3">
              {metrics.sessionsDone}/{metrics.sessionsPlanned} hechas
            </span>
          ) : null}
        </span>
      </button>

      {targetKm != null ? (
        <div className="px-4 pb-4">
          <ProgressBar value={km} target={targetKm} />
        </div>
      ) : null}

      {isOpen ? (
        <div className="border-t border-line p-4">
          <WeekFields week={week} onReload={onReload} onError={onError} />

          <div className="mt-5 space-y-4">
            {days.map((day) => {
              const plan = week.days.find((d) => d.date === day)
              return (
                <div key={day} className="space-y-2">
                  <div className="flex items-center justify-between">
                    <p className="text-[0.6875rem] font-medium uppercase tracking-widest text-label-4">
                      {dayFmt.format(new Date(day))}
                    </p>
                    <button
                      type="button"
                      onClick={() => onAdd(day)}
                      className="text-xs text-label-2 underline underline-offset-4"
                    >
                      Añadir
                    </button>
                  </div>

                  {plan?.sessions.map((match) => (
                    <SessionCard
                      key={match.session.id}
                      match={match}
                      onToggle={match.activity ? undefined : () => onToggle(match)}
                      onEdit={() => onEdit(match.session)}
                    />
                  ))}
                  {plan?.extras.map((activity) => (
                    <ExtraCard key={activity.id} activity={activity} />
                  ))}
                </div>
              )
            })}
          </div>
        </div>
      ) : null}
    </Card>
  )
}

/** Phase, focus and volume target for one week. Saved on blur — there is no Save button
 *  to forget, and a stray keystroke costs one request. */
function WeekFields({
  week,
  onReload,
  onError,
}: {
  week: WeekPlan
  onReload: () => Promise<void>
  onError: (message: string | null) => void
}) {
  const [phase, setPhase] = useState(week.week?.phase ?? '')
  const [focus, setFocus] = useState(week.week?.focus ?? '')
  const [targetKm, setTargetKm] = useState(
    week.week?.targetVolumeM == null ? '' : String(week.week.targetVolumeM / 1000),
  )
  const isDownWeek = week.week?.isDownWeek ?? false

  async function save(patch: Parameters<typeof updateWeek>[1]) {
    onError(null)
    try {
      await updateWeek(week.weekIndex, patch)
      await onReload()
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : 'No se pudo guardar la semana')
    }
  }

  const km = targetKm.trim() === '' ? null : Number(targetKm)

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3">
        <Field label="Fase">
          <TextInput
            value={phase}
            placeholder="Base y volumen"
            onChange={(e) => setPhase(e.target.value)}
            onBlur={() => void save({ phase: phase.trim() || null })}
          />
        </Field>
        <Field label="Objetivo (km)">
          <TextInput
            inputMode="decimal"
            value={targetKm}
            placeholder="42"
            onChange={(e) => setTargetKm(e.target.value)}
            onBlur={() =>
              void save({
                targetVolumeM: km != null && Number.isFinite(km) && km > 0 ? km * 1000 : null,
              })
            }
          />
        </Field>
      </div>

      <Field label="Enfoque">
        <TextInput
          value={focus}
          placeholder="1 sesión de calidad, tirada larga hasta 16 km"
          onChange={(e) => setFocus(e.target.value)}
          onBlur={() => void save({ focus: focus.trim() || null })}
        />
      </Field>

      <Button
        onClick={() => void save({ isDownWeek: !isDownWeek })}
        className={cn('w-full', isDownWeek && 'border-amber/40 text-amber')}
      >
        {isDownWeek ? 'Semana de descarga ✓' : 'Marcar como semana de descarga'}
      </Button>
    </div>
  )
}
