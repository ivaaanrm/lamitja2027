import { useState } from 'react'
import { cn } from '@/lib/cn'
import type { WeekMetrics } from '@/lib/metrics'
import { setDone, updateWeek } from '@/lib/plan-client'
import { weekDays, type MatchedSession, type WeekPlan } from '@/lib/plan'
import type { PlanSession } from '@/lib/db/schema'
import { SessionForm } from './SessionForm'
import { ExtraRow, SessionRow } from './SessionRow'
import { useBlock } from './useBlock'
import { Button, Card, Chip, Field, ProgressBar, TextInput } from './ui'

const rangeFmt = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' })
const dayFmt = new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', timeZone: 'UTC' })

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
        <p className="text-sm text-red-400">{error}</p>
      </Card>
    )
  }
  if (!data || !progress) {
    return (
      <Card>
        <p className="text-sm text-neutral-500">Loading…</p>
      </Card>
    )
  }

  async function toggle(match: MatchedSession) {
    setActionError(null)
    try {
      await setDone(match.session.id, !match.done)
      await reload()
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : 'Could not save')
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

      {actionError ? <p className="mt-4 text-center text-xs text-red-400">{actionError}</p> : null}

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
    <Card className={cn('p-0', isCurrent && 'border-neutral-600')}>
      <button
        type="button"
        onClick={onOpen}
        aria-expanded={isOpen}
        className="flex w-full items-center justify-between gap-3 p-4 text-left"
      >
        <span className="min-w-0">
          <span className="flex items-center gap-2">
            <span className="text-sm font-medium">W{week.weekIndex + 1}</span>
            <span className="text-xs text-neutral-500">
              {rangeFmt.format(new Date(days[0]))} – {rangeFmt.format(new Date(days[6]))}
            </span>
            {metrics.isDownWeek ? <Chip tone="down">Down</Chip> : null}
          </span>
          {metrics.phase ? (
            <span className="mt-1 block truncate text-xs text-neutral-500">{metrics.phase}</span>
          ) : null}
        </span>

        <span className="shrink-0 text-right">
          <span className="block text-sm tabular-nums">
            {km.toFixed(1)}
            {targetKm != null ? (
              <span className="text-neutral-500"> / {targetKm.toFixed(0)}</span>
            ) : null}
            <span className="ml-1 text-xs text-neutral-500">km</span>
          </span>
          {metrics.sessionsPlanned > 0 ? (
            <span className="block text-xs tabular-nums text-neutral-500">
              {metrics.sessionsDone}/{metrics.sessionsPlanned} done
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
        <div className="border-t border-neutral-800 p-4">
          <WeekFields week={week} onReload={onReload} onError={onError} />

          <div className="mt-5 divide-y divide-neutral-800">
            {days.map((day) => {
              const plan = week.days.find((d) => d.date === day)
              return (
                <div key={day} className="py-2 first:pt-0">
                  <div className="flex items-center justify-between pt-2">
                    <p className="text-[0.6875rem] uppercase tracking-widest text-neutral-600">
                      {dayFmt.format(new Date(day))}
                    </p>
                    <button
                      type="button"
                      onClick={() => onAdd(day)}
                      className="text-xs text-neutral-400 underline underline-offset-4"
                    >
                      Add
                    </button>
                  </div>

                  {plan?.sessions.map((match) => (
                    <SessionRow
                      key={match.session.id}
                      match={match}
                      onToggle={match.activity ? undefined : () => onToggle(match)}
                      onEdit={() => onEdit(match.session)}
                    />
                  ))}
                  {plan?.extras.map((activity) => (
                    <ExtraRow key={activity.id} activity={activity} />
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
      onError(cause instanceof Error ? cause.message : 'Could not save the week')
    }
  }

  const km = targetKm.trim() === '' ? null : Number(targetKm)

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3">
        <Field label="Phase">
          <TextInput
            value={phase}
            placeholder="Base & volume"
            onChange={(e) => setPhase(e.target.value)}
            onBlur={() => void save({ phase: phase.trim() || null })}
          />
        </Field>
        <Field label="Target (km)">
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

      <Field label="Focus">
        <TextInput
          value={focus}
          placeholder="1 quality session, long run to 16 km"
          onChange={(e) => setFocus(e.target.value)}
          onBlur={() => void save({ focus: focus.trim() || null })}
        />
      </Field>

      <Button
        onClick={() => void save({ isDownWeek: !isDownWeek })}
        className={cn('w-full', isDownWeek && 'border-amber-700/70 text-amber-400')}
      >
        {isDownWeek ? 'Down week ✓' : 'Mark as down week'}
      </Button>
    </div>
  )
}
