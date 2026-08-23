import { useEffect, useMemo, useState } from 'react'
import { formatClock, formatDuration, formatKm, formatPace, isRun, paceSKm } from '@/lib/activity'
import { activityLoad } from '@/lib/analytics'
import { cn } from '@/lib/cn'
import type { Activity, PlanSession } from '@/lib/db/schema'
import { decimal } from '@/lib/format'
import { ZONE_FLOOR_BPM, ZONE_NAME, hrZone, zoneTag, type Zone } from '@/lib/paces'
import type { SessionType } from '@/lib/plan'
import type { ActivityDetail as Detail, Split, TracePoint } from '@/lib/streams'
import { LineChart, StackedBar } from './charts'
import { useBlock } from './useBlock'
import { ACCENT, Card, CardTitle, Chip, Stat, TypeChip, ZONE_ACCENT } from './ui'

/**
 * One activity, opened from the log: what the watch recorded, drawn over distance.
 *
 * Two sources, painted in two steps. The summary — name, distance, time, averages — is
 * already in the `/api/data` payload the log was rendered from, so it paints on the first
 * frame; the trace behind it comes from Strava through `/api/activities/:id` and fills in
 * underneath a moment later. The id lives in the query string and is read in an effect,
 * because this island is also rendered at build time in a Worker with no `location`.
 */
export function ActivityDetail() {
  const { data, weeks, error } = useBlock()
  const [id, setId] = useState<number | null>(null)
  const [detail, setDetail] = useState<Detail | null>(null)
  const [detailError, setDetailError] = useState<string | null>(null)

  useEffect(() => {
    const value = Number(new URLSearchParams(location.search).get('id'))
    setId(Number.isInteger(value) && value > 0 ? value : null)
  }, [])

  useEffect(() => {
    if (id == null) return
    let cancelled = false
    fetch(`/api/activities/${id}`)
      .then(async (response) => {
        if (response.status === 401) {
          location.href = '/login'
          return
        }
        const body = (await response.json()) as Detail | { error: string }
        if (cancelled) return
        if (!response.ok || 'error' in body) {
          setDetailError('error' in body ? body.error : `No se pudo cargar la actividad (${response.status})`)
          return
        }
        setDetail(body)
      })
      .catch((cause: unknown) => {
        if (!cancelled) setDetailError(cause instanceof Error ? cause.message : 'No se pudo contactar con el servidor')
      })
    return () => {
      cancelled = true
    }
  }, [id])

  const activity = useMemo(() => data?.activities.find((a) => a.id === id) ?? null, [data, id])

  /** The prescribed session this run answered, if any. */
  const answered = useMemo(() => {
    for (const week of weeks) {
      for (const match of week.sessions) {
        if (match.activity?.id === id) return match.session
      }
    }
    return null
  }, [weeks, id])

  if (error && !data) {
    return (
      <Card>
        <p className="text-sm text-red">{error}</p>
      </Card>
    )
  }
  if (!data || id === null) {
    return (
      <Card>
        <p className="text-sm text-label-3">{data && id === null ? 'Falta el id de la actividad.' : 'Cargando…'}</p>
      </Card>
    )
  }
  if (!activity) {
    return (
      <Card>
        <p className="text-sm text-label-3">Esa actividad no está en el bloque.</p>
        <BackLink />
      </Card>
    )
  }

  return (
    <>
      <Header activity={activity} answered={answered} />
      <Summary activity={activity} />
      {detailError ? (
        <Card>
          <p className="text-sm text-red">{detailError}</p>
        </Card>
      ) : detail ? (
        <>
          <Traces activity={activity} trace={detail.trace} answered={answered} />
          <Zones zoneS={detail.zoneS} />
          {detail.laps.length > 0 ? (
            <SplitTable title="Series" rows={detail.laps} labelFor={(lap, i) => String(detail.laps[i]?.index ?? i + 1)} />
          ) : null}
          {detail.splits.length > 0 ? (
            <SplitTable title="Parciales" rows={detail.splits} labelFor={(_, i) => String(i + 1)} />
          ) : null}
          {detail.description ? (
            <Card>
              <CardTitle>Notas</CardTitle>
              <p className="whitespace-pre-line text-sm leading-relaxed text-label-2">{detail.description}</p>
            </Card>
          ) : null}
        </>
      ) : (
        <Card>
          <p className="text-sm text-label-3">Cargando el registro del reloj…</p>
        </Card>
      )}
      <Card>
        <a
          href={`https://www.strava.com/activities/${activity.id}`}
          target="_blank"
          rel="noreferrer"
          className="text-xs text-label-2 underline underline-offset-4"
        >
          Ver en Strava
        </a>
      </Card>
    </>
  )
}

const dateFmt = new Intl.DateTimeFormat('es-ES', {
  weekday: 'long',
  day: 'numeric',
  month: 'long',
  hour: '2-digit',
  minute: '2-digit',
  timeZone: 'UTC',
})

function BackLink() {
  return (
    <a href="/registro" className="mt-3 inline-block text-xs text-label-2 underline underline-offset-4">
      Volver al registro
    </a>
  )
}

function Header({ activity, answered }: { activity: Activity; answered: PlanSession | null }) {
  return (
    <Card className="pt-0">
      <a href="/registro" className="text-xs text-label-2 underline underline-offset-4">
        ← Registro
      </a>
      <h2 className="mt-3 text-xl font-semibold tracking-tight">{activity.name}</h2>
      <p className="mt-1 text-sm text-label-3">{dateFmt.format(new Date(activity.startedOn))}</p>
      {answered ? (
        <p className="mt-3 flex items-center gap-2">
          <TypeChip type={answered.type} />
          <Chip tone="done">Cumplió</Chip>
          <span className="truncate text-xs text-label-2">{answered.title}</span>
        </p>
      ) : null}
    </Card>
  )
}

function Summary({ activity }: { activity: Activity }) {
  const run = isRun(activity.sportType)
  const zone = activity.averageHeartrate == null ? null : hrZone(activity.averageHeartrate)

  return (
    <Card>
      <dl className="grid grid-cols-3 gap-y-5">
        <Stat label="Distancia" value={`${formatKm(activity.distanceM)} km`} />
        <Stat label="Tiempo" value={formatClock(activity.movingS)} hint="en movimiento" />
        {run ? (
          <Stat label="Ritmo" value={formatPace(paceSKm(activity.distanceM, activity.movingS))} hint="min/km" />
        ) : (
          <Stat label="Duración" value={formatDuration(activity.movingS)} />
        )}
        <Stat
          label="Pulso"
          value={activity.averageHeartrate ? Math.round(activity.averageHeartrate) : '—'}
          hint={
            zone ? (
              <span className={ZONE_ACCENT[zone].text}>
                {ZONE_NAME[zone]}
                {activity.maxHeartrate ? ` · máx ${Math.round(activity.maxHeartrate)}` : ''}
              </span>
            ) : undefined
          }
        />
        <Stat
          label="Cadencia"
          value={
            activity.cadenceSpm == null ? (
              '—'
            ) : (
              <span className={activity.cadenceSpm >= 170 ? 'text-mint' : 'text-amber'}>
                {activity.cadenceSpm}
              </span>
            )
          }
          hint={activity.cadenceSpm == null ? undefined : 'pasos/min'}
        />
        <Stat label="Desnivel" value={`${decimal(activity.elevationGainM ?? 0, 0)} m`} />
        <Stat
          label="Esfuerzo"
          value={Math.round(activityLoad(activity))}
          hint={activity.sufferScore == null ? 'estimado' : 'relativo'}
        />
      </dl>
    </Card>
  )
}

// ---------------------------------------------------------------------------
// Traces
// ---------------------------------------------------------------------------

/** The pace the session asked for, as reference rules on the trace. */
function paceRules(session: PlanSession | null): { at: number; className?: string }[] {
  return [session?.targetPaceLoSKm, session?.targetPaceHiSKm]
    .filter(isNumber)
    .map((at) => ({ at, className: 'stroke-mint/60' }))
}

function Traces({
  activity,
  trace,
  answered,
}: {
  activity: Activity
  trace: TracePoint[]
  answered: PlanSession | null
}) {
  if (trace.length === 0) {
    return (
      <Card>
        <p className="text-sm text-label-3">Esta actividad no tiene registro del reloj.</p>
      </Card>
    )
  }

  const pace = trace.map((p) => p.paceSKm)
  const hr = trace.map((p) => p.heartrate)
  const cadence = trace.map((p) => p.cadenceSpm)
  const altitude = trace.map((p) => p.altitudeM)
  const km = trace.map((p) => p.distanceM / 1000)
  const run = isRun(activity.sportType)

  return (
    <>
      {run && pace.some((v) => v != null) ? (
        <Trace
          title="Ritmo"
          value={`${formatPace(paceSKm(activity.distanceM, activity.movingS))}/km`}
          span={range(pace, formatPace)}
          km={km}
        >
          <LineChart
            label="Ritmo por kilómetro a lo largo de la distancia"
            steps={trace.length}
            backdrop={altitude}
            series={[{ values: pace, className: 'stroke-label', areaClassName: 'fill-label/10' }]}
            // Fast is up. The floor is a hair under the quickest bin so a single surge
            // does not flatten the rest of the run; the ceiling is clipped at 8:00 so a
            // walk break does not either.
            yMin={Math.max(0, Math.min(...pace.filter(isNumber)) - 10)}
            yMax={Math.min(480, Math.max(...pace.filter(isNumber)) + 10)}
            invert
            rules={paceRules(answered)}
          />
        </Trace>
      ) : null}

      {hr.some((v) => v != null) ? (
        <Trace
          title="Pulso"
          value={activity.averageHeartrate ? `${Math.round(activity.averageHeartrate)} de media` : ''}
          span={range(hr, String)}
          km={km}
        >
          <LineChart
            label="Pulso a lo largo de la distancia"
            steps={trace.length}
            backdrop={altitude}
            series={[{ values: hr, className: 'stroke-red', areaClassName: 'fill-red/10' }]}
            yMin={Math.min(...hr.filter(isNumber)) - 5}
            yMax={Math.max(...hr.filter(isNumber)) + 5}
            rules={([2, 3, 4, 5] as const).map((zone) => ({ at: ZONE_FLOOR_BPM[zone] }))}
          />
          <p className="mt-1 text-[0.625rem] text-label-4">Las líneas son los umbrales de zona, Z2 a Z5.</p>
        </Trace>
      ) : null}

      {cadence.some((v) => v != null) ? (
        <Trace
          title="Cadencia"
          value={activity.cadenceSpm ? `${activity.cadenceSpm} pasos/min` : ''}
          span={range(cadence, String)}
          km={km}
        >
          <LineChart
            label="Cadencia a lo largo de la distancia"
            steps={trace.length}
            backdrop={altitude}
            series={[{ values: cadence, className: 'stroke-blue' }]}
            yMin={Math.min(...cadence.filter(isNumber)) - 5}
            yMax={Math.max(...cadence.filter(isNumber)) + 5}
            rules={[{ at: 170, className: 'stroke-mint/60' }]}
          />
          <p className="mt-1 text-[0.625rem] text-label-4">La línea es el objetivo del protocolo de rodilla, 170 pasos/min.</p>
        </Trace>
      ) : null}

      {altitude.some((v) => v != null) ? (
        <p className="-mt-2 text-[0.625rem] text-label-4">
          El relieve de fondo es la altitud: {range(altitude, (v) => `${v} m`)}.
        </p>
      ) : null}
    </>
  )
}

const isNumber = (v: number | null | undefined): v is number => v != null

/** `3:52 – 5:10`: the quick and the slow end of a trace, for the corner of its card. */
function range(values: (number | null)[], fmt: (v: number) => string): string {
  const present = values.filter(isNumber)
  if (present.length === 0) return ''
  return `${fmt(Math.min(...present))} – ${fmt(Math.max(...present))}`
}

function Trace({
  title,
  value,
  span,
  km,
  children,
}: {
  title: string
  value: string
  span: string
  km: number[]
  children: React.ReactNode
}) {
  const total = km.at(-1) ?? 0
  // One tick per kilometre up to ten, then every five — and always the end.
  const step = total > 12 ? 5 : 1
  const ticks = Array.from({ length: Math.floor(total / step) }, (_, i) => (i + 1) * step)

  return (
    <Card>
      <CardTitle action={<span className="text-xs tabular-nums text-label-3">{span}</span>}>{title}</CardTitle>
      <p className="mb-2 text-sm tabular-nums text-label-2">{value}</p>
      {children}
      <div className="relative mt-1 h-3 text-[0.625rem] tabular-nums text-label-4">
        {ticks.map((tick) => (
          <span key={tick} className="absolute -translate-x-1/2" style={{ left: `${(tick / total) * 100}%` }}>
            {tick}
          </span>
        ))}
        <span className="absolute right-0">{decimal(total)} km</span>
      </div>
    </Card>
  )
}

// ---------------------------------------------------------------------------
// Zones and splits
// ---------------------------------------------------------------------------

function Zones({ zoneS }: { zoneS: Record<Zone, number> }) {
  const zones = [1, 2, 3, 4, 5] as const
  const total = zones.reduce((sum, z) => sum + zoneS[z], 0)
  if (total <= 0) return null

  return (
    <Card>
      <CardTitle>Tiempo por zona</CardTitle>
      <StackedBar parts={zones.map((z) => ({ key: z, value: zoneS[z], className: ZONE_ACCENT[z].bar }))} />
      <ul className="mt-3 grid grid-cols-5 gap-1">
        {zones.map((z) => (
          <li key={z}>
            <span className={cn('block text-xs font-semibold', ZONE_ACCENT[z].text)}>{zoneTag(z)}</span>
            <span className="block text-xs tabular-nums text-label-2">{formatDuration(zoneS[z])}</span>
            <span className="block text-[0.625rem] tabular-nums text-label-4">
              {Math.round((zoneS[z] / total) * 100)} %
            </span>
          </li>
        ))}
      </ul>
    </Card>
  )
}

function SplitTable<T extends Split>({
  title,
  rows,
  labelFor,
}: {
  title: string
  rows: T[]
  labelFor: (row: T, index: number) => string
}) {
  const fastest = Math.min(...rows.filter((r) => r.distanceM >= 200).map((r) => r.paceSKm))
  const hasHr = rows.some((r) => r.heartrate != null)

  return (
    <Card>
      <CardTitle>{title}</CardTitle>
      <table className="w-full text-sm tabular-nums">
        <thead className="text-[0.625rem] uppercase tracking-widest text-label-4">
          <tr>
            <th className="py-1 text-left font-medium">#</th>
            <th className="py-1 text-right font-medium">km</th>
            <th className="py-1 text-right font-medium">Ritmo</th>
            {hasHr ? <th className="py-1 text-right font-medium">Pulso</th> : null}
            <th className="py-1 text-right font-medium">Desn.</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => {
            const zone = row.heartrate == null ? null : hrZone(row.heartrate)
            return (
              <tr key={i} className="border-t border-line">
                <td className="py-1.5 text-left text-label-3">{labelFor(row, i)}</td>
                <td className="py-1.5 text-right text-label-2">{formatKm(row.distanceM)}</td>
                <td className={cn('py-1.5 text-right', row.paceSKm === fastest ? 'font-semibold text-mint' : 'text-label')}>
                  {row.paceSKm > 0 ? formatPace(row.paceSKm) : '—'}
                </td>
                {hasHr ? (
                  <td className={cn('py-1.5 text-right', zone ? ZONE_ACCENT[zone].text : 'text-label-4')}>
                    {row.heartrate ?? '—'}
                  </td>
                ) : null}
                <td className="py-1.5 text-right text-label-3">
                  {row.elevationM == null ? '—' : `${row.elevationM > 0 ? '+' : ''}${Math.round(row.elevationM)}`}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </Card>
  )
}
