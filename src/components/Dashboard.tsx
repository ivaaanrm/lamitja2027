import { useState } from 'react'
import { formatDuration, formatKm, formatPace, isRun, paceSKm } from '@/lib/activity'
import { BLOCK_START, TOTAL_WEEKS, daysToRace, startOfDay } from '@/lib/block'
import { cn } from '@/lib/cn'
import { GOAL_PACE_S_KM, type WeekMetrics } from '@/lib/metrics'
import { setDone } from '@/lib/plan-client'
import type { MatchedSession, WeekPlan } from '@/lib/plan'
import { ExtraRow, SessionRow } from './SessionRow'
import { WeekCalendar } from './WeekCalendar'
import { useBlock } from './useBlock'
import { Card, CardTitle, Chip, ProgressBar, Stat } from './ui'

const dayFmt = new Intl.DateTimeFormat('en-GB', {
  weekday: 'short',
  day: 'numeric',
  month: 'short',
  // Dates are stored as UTC midnight of the local day; formatting in the viewer's zone
  // would slide them a day for anyone west of UTC.
  timeZone: 'UTC',
})
const timeFmt = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit' })

export function Dashboard() {
  const { data, error, reload, weeks, progress, currentWeek } = useBlock()
  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)

  async function sync() {
    setBusy(true)
    setActionError(null)
    try {
      const response = await fetch('/api/sync', { method: 'POST' })
      if (!response.ok) {
        setActionError(((await response.json()) as { error?: string }).error ?? 'Sync failed')
      }
      await reload()
    } finally {
      setBusy(false)
    }
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

  if (!data.stravaConnected) {
    return (
      <Card>
        <p className="text-sm text-neutral-400">Connect Strava to pull in this block's runs.</p>
        <a
          href="/api/strava/connect"
          className="mt-4 inline-flex h-11 items-center justify-center rounded-xl bg-[#fc4c02] px-5 text-sm font-semibold text-white active:opacity-80"
        >
          Connect with Strava
        </a>
      </Card>
    )
  }

  const week = weeks[currentWeek]
  const metrics = progress.weekly[currentWeek]
  const notStarted = Date.now() < BLOCK_START

  const recent = data.activities
    .filter((a) => isRun(a.sportType))
    .sort((a, b) => b.startedOn - a.startedOn)
    .slice(0, 6)

  return (
    <>
      <ThisWeekHeader metrics={metrics} notStarted={notStarted} week={week} />
      <ThisWeek week={week} onToggle={toggle} />

      <Card>
        <CardTitle
          action={
            <button
              type="button"
              onClick={() => void sync()}
              disabled={busy}
              className="text-xs text-neutral-400 underline underline-offset-4 disabled:opacity-50"
            >
              {busy ? 'Syncing…' : 'Sync'}
            </button>
          }
        >
          Last runs
        </CardTitle>

        {recent.length === 0 ? (
          <p className="text-sm text-neutral-500">
            Nothing yet. The block opens {dayFmt.format(new Date(BLOCK_START))}.
          </p>
        ) : (
          <ul className="divide-y divide-neutral-800">
            {recent.map((run) => (
              <li key={run.id} className="flex items-baseline justify-between gap-3 py-3">
                <div className="min-w-0">
                  <p className="truncate text-sm">{run.name}</p>
                  <p className="text-xs text-neutral-500">
                    {dayFmt.format(new Date(run.startedOn))}
                    {run.cadenceSpm ? ` · ${run.cadenceSpm} spm` : ''}
                    {run.averageHeartrate ? ` · ${Math.round(run.averageHeartrate)} bpm` : ''}
                  </p>
                </div>
                <div className="shrink-0 text-right">
                  <p className="text-sm tabular-nums">{formatKm(run.distanceM)} km</p>
                  <p className="text-xs tabular-nums text-neutral-500">
                    {formatPace(paceSKm(run.distanceM, run.movingS))}/km
                  </p>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <BlockProgressCard progress={progress} currentWeek={currentWeek} />

      <p className="text-center text-xs text-neutral-600">
        {data.lastSyncAt
          ? `Synced ${dayFmt.format(new Date(data.lastSyncAt))} at ${timeFmt.format(new Date(data.lastSyncAt))}`
          : 'Never synced'}
      </p>

      {actionError ? <p className="text-center text-xs text-red-400">{actionError}</p> : null}
    </>
  )
}

function ThisWeekHeader({
  metrics,
  notStarted,
  week,
}: {
  metrics: WeekMetrics
  notStarted: boolean
  week: WeekPlan | undefined
}) {
  const km = metrics.totals.distanceM / 1000
  const targetKm = metrics.targetVolumeM == null ? null : metrics.targetVolumeM / 1000

  return (
    <Card>
      <div className="flex items-baseline justify-between gap-3">
        <p className="text-xs font-medium uppercase tracking-widest text-neutral-500">
          {notStarted ? 'Week 1 starts soon' : `Week ${metrics.weekIndex + 1} of ${TOTAL_WEEKS}`}
        </p>
        <p className="text-xs text-neutral-500">{daysToRace(Date.now())} days to go</p>
      </div>

      <p className="mt-2 text-4xl font-semibold tabular-nums">
        {km.toFixed(1)}
        <span className="ml-1.5 text-base font-normal text-neutral-500">
          {targetKm == null ? 'km this week' : `of ${targetKm.toFixed(0)} km`}
        </span>
      </p>

      {targetKm != null ? (
        <div className="mt-3">
          <ProgressBar value={km} target={targetKm} />
        </div>
      ) : null}

      {week ? <WeekCalendar week={week} today={startOfDay(Date.now())} className="mt-5" /> : null}

      <div className="mt-4 flex flex-wrap items-center gap-2">
        {metrics.phase ? <Chip>{metrics.phase}</Chip> : null}
        {metrics.isDownWeek ? <Chip tone="down">Down week</Chip> : null}
        {metrics.sessionsPlanned > 0 ? (
          <Chip tone={metrics.sessionsDone === metrics.sessionsPlanned ? 'done' : 'neutral'}>
            {metrics.sessionsDone}/{metrics.sessionsPlanned} sessions
          </Chip>
        ) : null}
      </div>
    </Card>
  )
}

function ThisWeek({ week, onToggle }: { week: WeekPlan; onToggle: (m: MatchedSession) => void }) {
  const days = week.days.filter((day) => day.sessions.length > 0 || day.extras.length > 0)

  return (
    <Card>
      <CardTitle
        action={
          <a href="/plan" className="text-xs text-neutral-400 underline underline-offset-4">
            Edit plan
          </a>
        }
      >
        This week
      </CardTitle>

      {days.length === 0 ? (
        <p className="text-sm text-neutral-500">
          Nothing planned for this week yet.{' '}
          <a href="/plan" className="underline underline-offset-4">
            Write it
          </a>
          .
        </p>
      ) : (
        <div className="divide-y divide-neutral-800">
          {days.map((day) => (
            <div key={day.date} className="py-1 first:pt-0 last:pb-0">
              <p className="pt-3 text-[0.6875rem] uppercase tracking-widest text-neutral-600">
                {dayFmt.format(new Date(day.date))}
              </p>
              {day.sessions.map((match) => (
                <SessionRow
                  key={match.session.id}
                  match={match}
                  // A matched activity already settles the question; only sessions Strava
                  // will never report — strength, cross — get a tick box.
                  onToggle={match.activity ? undefined : () => onToggle(match)}
                />
              ))}
              {day.extras.map((activity) => (
                <ExtraRow key={activity.id} activity={activity} />
              ))}
            </div>
          ))}
        </div>
      )}
    </Card>
  )
}

function BlockProgressCard({
  progress,
  currentWeek,
}: {
  progress: NonNullable<ReturnType<typeof useBlock>['progress']>
  currentWeek: number
}) {
  const { block } = progress
  const doneKm = block.distanceM / 1000
  const plannedToDateKm = progress.plannedToDateM == null ? null : progress.plannedToDateM / 1000
  const plannedTotalKm = progress.plannedTotalM == null ? null : progress.plannedTotalM / 1000

  return (
    <Card>
      <CardTitle>Toward 24 January</CardTitle>

      <dl className="grid grid-cols-3 gap-y-5">
        <Stat
          label="Block km"
          value={doneKm.toFixed(0)}
          hint={plannedTotalKm ? `of ${plannedTotalKm.toFixed(0)} planned` : `${block.runs} runs`}
        />
        <Stat
          label="Mean pace"
          value={block.meanPaceSKm ? `${formatPace(block.meanPaceSKm)}` : '—'}
          hint={`goal ${formatPace(GOAL_PACE_S_KM)}/km`}
        />
        <Stat
          label="Longest"
          value={block.longestM ? formatKm(block.longestM) : '—'}
          hint="of 21.1 km"
        />
        <Stat label="Runs" value={block.runs} hint={formatDuration(block.movingS)} />
        <Stat
          label="Cadence"
          value={block.meanCadenceSpm ? Math.round(block.meanCadenceSpm) : '—'}
          hint="spm, target 170+"
        />
        <Stat
          label="Weeks left"
          value={progress.weeksRemaining}
          hint={`${progress.weeksElapsed} done`}
        />
      </dl>

      {plannedToDateKm != null ? (
        <p className="mt-5 text-xs text-neutral-500">
          {doneKm.toFixed(0)} km run against {plannedToDateKm.toFixed(0)} km planned to date —{' '}
          <span className={cn(doneKm >= plannedToDateKm ? 'text-emerald-400' : 'text-amber-400')}>
            {doneKm >= plannedToDateKm ? 'on track' : `${(plannedToDateKm - doneKm).toFixed(0)} km behind`}
          </span>
          .
        </p>
      ) : null}

      <VolumeChart weekly={progress.weekly} currentWeek={currentWeek} />
    </Card>
  )
}

/** Weekly volume across the whole block, with each week's target as a dashed rule. */
function VolumeChart({ weekly, currentWeek }: { weekly: WeekMetrics[]; currentWeek: number }) {
  const max = Math.max(
    1,
    ...weekly.map((w) => Math.max(w.totals.distanceM, w.targetVolumeM ?? 0)),
  )

  return (
    <figure className="mt-5">
      <div className="flex h-20 items-end gap-[2px]">
        {weekly.map((w) => {
          const target = w.targetVolumeM == null ? null : (w.targetVolumeM / max) * 100
          return (
            <div
              key={w.weekIndex}
              className="relative flex h-full flex-1 items-end"
              title={`Week ${w.weekIndex + 1}: ${(w.totals.distanceM / 1000).toFixed(1)} km`}
            >
              {target != null ? (
                <span
                  aria-hidden
                  className="absolute inset-x-0 border-t border-dashed border-neutral-600"
                  style={{ bottom: `${Math.min(100, target)}%` }}
                />
              ) : null}
              <span
                className={cn(
                  'w-full rounded-sm',
                  w.weekIndex === currentWeek ? 'bg-neutral-100' : 'bg-neutral-700',
                )}
                style={{ height: `${(w.totals.distanceM / max) * 100}%` }}
              />
            </div>
          )
        })}
      </div>
      <figcaption className="mt-2 flex justify-between text-[0.625rem] tabular-nums text-neutral-600">
        <span>W1</span>
        <span>{(max / 1000).toFixed(0)} km peak · dashed = target</span>
        <span>W{TOTAL_WEEKS}</span>
      </figcaption>
    </figure>
  )
}
