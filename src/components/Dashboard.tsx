import { useState } from 'react'
import { formatDuration, formatKm, formatPace, isRun, paceSKm } from '@/lib/activity'
import { BLOCK_START, TOTAL_WEEKS, daysToRace, startOfDay } from '@/lib/block'
import { cn } from '@/lib/cn'
import { decimal } from '@/lib/format'
import { GOAL_PACE_S_KM, type WeekMetrics } from '@/lib/metrics'
import { hrZone, zoneTag } from '@/lib/paces'
import { setDone } from '@/lib/plan-client'
import type { MatchedSession, WeekPlan } from '@/lib/plan'
import { ThisWeek } from './ThisWeek'
import { WeekCalendar } from './WeekCalendar'
import { useBlock } from './useBlock'
import { Card, CardTitle, Chip, ProgressBar, Stat } from './ui'

const dayFmt = new Intl.DateTimeFormat('es-ES', {
  weekday: 'short',
  day: 'numeric',
  month: 'short',
  // Dates are stored as UTC midnight of the local day; formatting in the viewer's zone
  // would slide them a day for anyone west of UTC.
  timeZone: 'UTC',
})
const timeFmt = new Intl.DateTimeFormat('es-ES', { hour: '2-digit', minute: '2-digit' })

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
        setActionError(((await response.json()) as { error?: string }).error ?? 'Fallo al sincronizar')
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
      setActionError(cause instanceof Error ? cause.message : 'No se pudo guardar')
    }
  }

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

  if (!data.stravaConnected) {
    return (
      <Card>
        <p className="text-sm text-label-2">Conecta Strava para traer las salidas de este bloque.</p>
        <a
          href="/api/strava/connect"
          className="mt-4 inline-flex h-11 items-center justify-center rounded-xl bg-[#fc4c02] px-5 text-sm font-semibold text-white active:opacity-80"
        >
          Conectar con Strava
        </a>
      </Card>
    )
  }

  const week = weeks[currentWeek]
  const metrics = progress.weekly[currentWeek]
  const notStarted = Date.now() < BLOCK_START
  const today = startOfDay(Date.now())

  const recent = data.activities
    .filter((a) => isRun(a.sportType))
    .sort((a, b) => b.startedOn - a.startedOn)
    .slice(0, 6)

  return (
    <>
      <ThisWeek week={week} today={today} onToggle={toggle} />
      <ThisWeekHeader metrics={metrics} notStarted={notStarted} week={week} today={today} />

      <Card>
        <CardTitle
          action={
            <button
              type="button"
              onClick={() => void sync()}
              disabled={busy}
              className="-my-2 inline-flex min-h-11 items-center px-2 text-xs text-label-2 underline underline-offset-4 disabled:opacity-50"
            >
              {busy ? 'Sincronizando…' : 'Sincronizar'}
            </button>
          }
        >
          Últimas salidas
        </CardTitle>

        {recent.length === 0 ? (
          <p className="text-sm text-label-3">
            Nada todavía. El bloque abre el {dayFmt.format(new Date(BLOCK_START))}.
          </p>
        ) : (
          <ul className="divide-y divide-line">
            {recent.map((run) => (
              <li key={run.id}>
                <a
                  href={`/actividad?id=${run.id}`}
                  className="flex min-h-14 items-center justify-between gap-3 py-3 transition-opacity active:opacity-60"
                >
                <div className="min-w-0">
                  <p className="truncate text-sm">{run.name}</p>
                  <p className="text-xs text-label-3">
                    {dayFmt.format(new Date(run.startedOn))}
                    {run.cadenceSpm ? ` · ${run.cadenceSpm} pasos/min` : ''}
                    {/* The zone, not the number — see the same call in SessionCard. */}
                    {run.averageHeartrate ? ` · ${zoneTag(hrZone(run.averageHeartrate))}` : ''}
                  </p>
                </div>
                  <div className="shrink-0 text-right">
                    <p className="data-number text-sm">{formatKm(run.distanceM)} km</p>
                    <p className="data-number text-xs text-label-3">
                      {formatPace(paceSKm(run.distanceM, run.movingS))}/km
                    </p>
                  </div>
                  <svg
                    aria-hidden
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    className="size-4 shrink-0 text-label-4"
                  >
                    <path d="m9 6 6 6-6 6" />
                  </svg>
                </a>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <BlockProgressCard progress={progress} currentWeek={currentWeek} />

      <p className="text-center text-xs text-label-4">
        {data.lastSyncAt
          ? `Sincronizado el ${dayFmt.format(new Date(data.lastSyncAt))} a las ${timeFmt.format(new Date(data.lastSyncAt))}`
          : 'Sin sincronizar todavía'}
      </p>

      {actionError ? <p className="text-center text-xs text-red">{actionError}</p> : null}
    </>
  )
}

function ThisWeekHeader({
  metrics,
  notStarted,
  week,
  today,
}: {
  metrics: WeekMetrics
  notStarted: boolean
  week: WeekPlan | undefined
  today: number
}) {
  const km = metrics.totals.distanceM / 1000
  const targetKm = metrics.targetVolumeM == null ? null : metrics.targetVolumeM / 1000

  return (
    <Card className="overflow-hidden">
      <div className="flex items-baseline justify-between gap-3">
        <p className="text-xs font-medium uppercase tracking-widest text-label-3">
          {notStarted ? 'La semana 1 empieza pronto' : `Semana ${metrics.weekIndex + 1} de ${TOTAL_WEEKS}`}
        </p>
        <p className="text-xs text-label-3">Faltan {daysToRace(Date.now())} días</p>
      </div>

      <div className="mt-3 flex items-end justify-between gap-4">
        <div className="min-w-0">
          <p className="data-number text-4xl font-semibold leading-none text-label">{decimal(km)}</p>
          <p className="mt-1.5 text-caption text-label-3">
            {targetKm == null ? 'km esta semana' : `de ${decimal(targetKm, 0)} km previstos`}
          </p>
        </div>
        <WeekRing
          value={targetKm != null ? km : metrics.sessionsDone}
          target={targetKm ?? metrics.sessionsPlanned}
          label={targetKm != null ? 'volumen' : 'sesiones'}
        />
      </div>

      {targetKm != null ? (
        <div className="mt-2.5">
          <ProgressBar value={km} target={targetKm} />
        </div>
      ) : null}

      {week ? <WeekCalendar week={week} today={today} className="mt-3" /> : null}

      <div className="mt-3 flex flex-wrap items-center gap-1.5">
        {metrics.phase ? <Chip>{metrics.phase}</Chip> : null}
        {metrics.isDownWeek ? <Chip tone="down">Descarga</Chip> : null}
        {metrics.sessionsPlanned > 0 ? (
          <Chip tone={metrics.sessionsDone === metrics.sessionsPlanned ? 'done' : 'neutral'}>
            {metrics.sessionsDone}/{metrics.sessionsPlanned} sesiones
          </Chip>
        ) : null}
      </div>
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
      <CardTitle>Rumbo al 24 de enero</CardTitle>

      <dl className="grid grid-cols-2 gap-x-6 gap-y-6">
        <Stat
          label="Km del bloque"
          value={decimal(doneKm, 0)}
          hint={plannedTotalKm ? `de ${decimal(plannedTotalKm, 0)} previstos` : `${block.runs} salidas`}
        />
        <Stat
          label="Ritmo medio"
          value={block.meanPaceSKm ? `${formatPace(block.meanPaceSKm)}` : '—'}
          hint={`objetivo ${formatPace(GOAL_PACE_S_KM)}/km`}
        />
        <Stat
          label="Más larga"
          value={block.longestM ? formatKm(block.longestM) : '—'}
          hint="de 21,1 km"
        />
        <Stat label="Salidas" value={block.runs} hint={formatDuration(block.movingS)} />
        <Stat
          label="Cadencia"
          value={block.meanCadenceSpm ? Math.round(block.meanCadenceSpm) : '—'}
          hint="pasos/min, objetivo 170+"
        />
        <Stat
          label="Quedan"
          value={progress.weeksRemaining}
          hint={`${progress.weeksElapsed} semanas hechas`}
        />
      </dl>

      {plannedToDateKm != null ? (
        <p className="mt-5 text-xs text-label-3">
          {decimal(doneKm, 0)} km corridos frente a {decimal(plannedToDateKm, 0)} km previstos hasta hoy —{' '}
          <span className={cn(doneKm >= plannedToDateKm ? 'text-mint' : 'text-amber')}>
            {doneKm >= plannedToDateKm
              ? 'según lo previsto'
              : `${decimal(plannedToDateKm - doneKm, 0)} km por debajo`}
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
              title={`Semana ${w.weekIndex + 1}: ${decimal(w.totals.distanceM / 1000)} km`}
            >
              {target != null ? (
                <span
                  aria-hidden
                  className="absolute inset-x-0 border-t border-dashed border-line-strong"
                  style={{ bottom: `${Math.min(100, target)}%` }}
                />
              ) : null}
              <span
                className={cn(
                  'w-full rounded-sm',
                  w.weekIndex === currentWeek ? 'bg-mint' : 'bg-fill-strong',
                )}
                style={{ height: `${(w.totals.distanceM / max) * 100}%` }}
              />
            </div>
          )
        })}
      </div>
      <figcaption className="mt-2 flex justify-between text-caption2 tabular-nums text-label-4">
        <span>S1</span>
        <span>pico de {decimal(max / 1000, 0)} km · discontinua = objetivo</span>
        <span>S{TOTAL_WEEKS}</span>
      </figcaption>
    </figure>
  )
}

function WeekRing({ value, target, label }: { value: number; target: number; label: string }) {
  const pct = target > 0 ? Math.max(0, Math.min(100, (value / target) * 100)) : 0
  const radius = 28
  const circumference = 2 * Math.PI * radius

  return (
    <figure
      aria-label={`${Math.round(pct)}% del objetivo de ${label}`}
      className="relative grid size-16 shrink-0 place-items-center"
    >
      <svg aria-hidden viewBox="0 0 72 72" className="absolute inset-0 size-full -rotate-90">
        <circle cx="36" cy="36" r={radius} fill="none" strokeWidth="6" className="stroke-fill-strong" />
        <circle
          cx="36"
          cy="36"
          r={radius}
          fill="none"
          strokeWidth="6"
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={circumference * (1 - pct / 100)}
          className="stroke-mint transition-[stroke-dashoffset]"
        />
      </svg>
      <span className="text-center">
        <span className="data-number block text-footnote font-semibold text-label">{Math.round(pct)}%</span>
        <span className="block text-caption2 text-label-3">{label}</span>
      </span>
    </figure>
  )
}
