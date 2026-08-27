import { useState } from 'react'
import { formatDuration, formatKm, formatPace, isRun, paceSKm } from '@/lib/activity'
import { BLOCK_START, RACE_DISTANCE_M, TOTAL_WEEKS, daysToRace, startOfDay } from '@/lib/block'
import { cn } from '@/lib/cn'
import type { Activity } from '@/lib/db/schema'
import { decimal } from '@/lib/format'
import { GOAL_PACE_S_KM, type BlockProgress, type WeekMetrics } from '@/lib/metrics'
import { hrZone, zoneTag } from '@/lib/paces'
import type { MatchedSession, WeekPlan } from '@/lib/plan'
import { setDone } from '@/lib/plan-client'
import { ThisWeek } from './ThisWeek'
import { WeekCalendar } from './WeekCalendar'
import { useBlock } from './useBlock'
import { island } from './Island'
import {
  CHEVRON_RIGHT,
  Card,
  CardTitle,
  EmptyState,
  ErrorCard,
  HeroMetric,
  Icon,
  LoadingCard,
  ProgressRing,
  Skeleton,
  Stat,
  StatStrip,
  TextLink,
} from './ui'

/**
 * `/` — the tab that gets opened most, and the only one that has to answer two questions
 * before a thumb moves: *what do I run today* and *am I on track this week*.
 *
 * The composition is hero-plus-ring over a day list, and it is deliberately a shape no
 * other tab repeats: one display-sized number (the week's kilometres) with its target as
 * an arc beside it, the seven days as a strip under it, and the session still owed one
 * card below in `ThisWeek`. Everything between those two got cut so the second question
 * lands above the fold — a card of this many parts is what pushed "what do I run today"
 * off the first screen.
 *
 * **There is no trend chart on Hoy any more, and that is the point.** This screen used to
 * carry a twelve-week line of weekly volume *and* a twenty-three-week bar of the same
 * quantity, and `/progreso` draws that bar too, against last season. Three renderings of
 * one number across two tabs is how four screens stop reading as one app: Hoy is *now* —
 * two rings, a week strip and the last runs — and trends belong to the screen named after
 * them.
 */

const dayFmt = new Intl.DateTimeFormat('es-ES', {
  weekday: 'short',
  day: 'numeric',
  month: 'short',
  // Activity dates are the athlete's local midnight stored as UTC; formatting them in the
  // viewer's zone would slide every one of them a day for anyone west of it.
  timeZone: 'UTC',
})

/**
 * The sync stamp is the only date on this screen that is a real *instant* rather than a
 * training day, so it reads in the viewer's own zone — pinning it to UTC put a 01:30 sync
 * on the previous day. One formatter, because it is one line.
 */
const syncFmt = new Intl.DateTimeFormat('es-ES', {
  day: 'numeric',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
})

function DashboardScreen() {
  const { data, error, now, reload, weeks, progress, currentWeek } = useBlock()
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

  if (error && !data)
    return <ErrorCard title="Sin datos del bloque" message={error} onRetry={() => void reload()} />

  if (!data || !progress) return <DashboardSkeleton />

  if (!data.stravaConnected) {
    return (
      <Card className="fade-up">
        <CardTitle>Strava</CardTitle>
        <EmptyState
          action={
            // Strava's own orange is the one hex in the repo: their brand guidelines own
            // this button, and `text-ink` is the token that reads as the white on it.
            <a
              href="/api/strava/connect"
              className="tappable inline-flex h-11 items-center justify-center rounded-xl bg-[#fc4c02] px-5 text-footnote font-semibold text-ink"
            >
              Conectar con Strava
            </a>
          }
        >
          El plan ya está aquí, pero faltan los kilómetros. Conecta Strava para traer las
          salidas de este bloque.
        </EmptyState>
      </Card>
    )
  }

  const week = weeks[currentWeek]
  const metrics = progress.weekly[currentWeek]
  // One clock for the whole screen: `useBlock` pins `now` at mount, so "today" cannot
  // drift between the strip and the day lines while the tab is open.
  const today = startOfDay(now)

  // The last four runs are exactly one training week of them, which is what makes this a
  // glance at "what have I just done" rather than a second copy of `/registro`.
  const recent = data.activities
    .filter((a) => isRun(a.sportType))
    .sort((a, b) => b.startedOn - a.startedOn)
    .slice(0, 4)

  return (
    <>
      <RaceCountdown now={now} />
      <WeekHero metrics={metrics} week={week} today={today} notStarted={now < BLOCK_START} />
      <ThisWeek week={week} today={today} onToggle={toggle} />
      <RecentRuns runs={recent} busy={busy} onSync={() => void sync()} />
      <RaceCard progress={progress} now={now} />

      <footer className="pt-0.5 text-center">
        <p className="text-caption text-label-4">
          {data.lastSyncAt
            ? `Sincronizado el ${syncFmt.format(new Date(data.lastSyncAt))}`
            : 'Sin sincronizar todavía'}
        </p>
        {/* Always rendered, empty or not: a live region has to be in the document *before*
            it changes to be announced, and an empty paragraph draws no line box. */}
        <p role="status" aria-live="polite" className="text-caption text-red">
          {actionError}
        </p>
      </footer>
    </>
  )
}

/**
 * How far away the race still is, as a line rather than a card.
 *
 * `RaceCard` at the foot of this screen already owns the countdown properly — an arc that
 * fills while the number falls, with the block's three qualifying numbers under it. This is
 * not a second copy of that: it is the same fact at the top of the screen, where the
 * question "how long have I got" is asked and where the answer currently required a scroll
 * past three cards.
 *
 * So it is deliberately *not* a `Card`. A second raised surface up here would read as a
 * second hero and push the week's kilometres — the thing this screen is actually about —
 * below the first viewport, which is the one measurement the home screen has to win. A
 * single hairline row costs about 36px and reads as chrome hung off the page heading,
 * which is what it is. Filled rather than outlined, like every other surface in this app —
 * a border here would be the only box on a screen made of filled panels.
 *
 * It counts in weeks as well as days because the plan is written in weeks: "22 semanas"
 * locates you in `/plan` in a way that "153 días" does not. Under a week the weeks clause
 * would say "0", so it is dropped rather than printed.
 *
 * Rendered from the island rather than from `App.astro`, which is prerendered — a
 * countdown baked at build time is a number that is wrong the next morning.
 */
function RaceCountdown({ now }: { now: number }) {
  const days = daysToRace(now)
  const weeks = Math.floor(days / 7)

  return (
    <div className="flex items-baseline justify-between gap-2 rounded-xl bg-fill px-3 py-2">
      <p className="text-caption2 font-semibold uppercase tracking-[0.16em] text-label-3">
        Cuenta atrás
      </p>
      {days === 0 ? (
        <p className="shrink-0 text-footnote font-semibold text-mint">Hoy es la carrera</p>
      ) : (
        <p className="shrink-0 text-caption text-label-3">
          <span className="data-number text-body font-semibold text-label">{days}</span>
          <span className="ml-1">{days === 1 ? 'día' : 'días'}</span>
          {weeks > 0 ? (
            <span>
              {' · '}
              <span className="tabular-nums">{weeks}</span> {weeks === 1 ? 'semana' : 'semanas'}
            </span>
          ) : null}
        </p>
      )}
    </div>
  )
}

/**
 * The one number this screen is about: kilometres run this week, with the week's target as
 * the arc beside it.
 *
 * Volume against a target is always a ring and never a bar — a bar is for a share that is
 * incidental to a row, and here the share *is* the question. The arc clamps at a full ring,
 * so the overshoot is said in words underneath instead.
 */
function WeekHero({
  metrics,
  week,
  today,
  notStarted,
}: {
  metrics: WeekMetrics
  week: WeekPlan | undefined
  /** UTC midnight of the current local day. */
  today: number
  notStarted: boolean
}) {
  const km = metrics.totals.distanceM / 1000
  const targetKm = metrics.targetVolumeM == null ? null : metrics.targetVolumeM / 1000

  // One qualifier is all the eyebrow fits, and a down week is the one that explains a
  // target that just fell off a cliff — so it takes the phase's place rather than queuing
  // up beside it.
  const qualifier = metrics.isDownWeek ? 'descarga' : metrics.phase

  return (
    <Card className="fade-up">
      <HeroMetric
        eyebrow={
          notStarted
            ? `El bloque abre el ${dayFmt.format(new Date(BLOCK_START))}`
            : `Semana ${metrics.weekIndex + 1} de ${TOTAL_WEEKS}${qualifier ? ` · ${qualifier}` : ''}`
        }
        value={decimal(km)}
        unit="km"
        context={weekContext(km, targetKm, notStarted)}
        trailing={
          targetKm != null && targetKm > 0 ? (
            <ProgressRing
              value={km}
              target={targetKm}
              size={64}
              label={`${Math.round((km / targetKm) * 100)}%`}
              sublabel="objetivo"
              ariaLabel={`${decimal(km)} km de los ${decimal(targetKm, 0)} previstos esta semana`}
            />
          ) : undefined
        }
      />

      {/* The week's shape, directly under the number it is made of. It prints no figures:
          the strip says which days are heavy and which are behind you, and the line for
          each day one card down says how far. */}
      {week ? <WeekCalendar week={week} today={today} className="mt-3" /> : null}

      <StatStrip className="mt-3">
        <Stat
          label="Sesiones"
          value={metrics.sessionsDone}
          hint={
            metrics.sessionsPlanned > 0
              ? `de ${metrics.sessionsPlanned} previstas`
              : 'sin sesiones previstas'
          }
        />
        <Stat label="Tiempo" value={formatDuration(metrics.totals.movingS)} hint="en movimiento" />
        <Stat
          label="Desnivel"
          value={`${decimal(metrics.totals.elevationM, 0)} m`}
          hint="acumulado"
        />
      </StatStrip>
    </Card>
  )
}

/** The sentence that stops the hero number being trivia: what it is still short of. */
function weekContext(km: number, targetKm: number | null, notStarted: boolean): string {
  if (notStarted) return 'La cuenta empieza el lunes que abre el bloque.'
  if (targetKm == null || targetKm <= 0) return 'Esta semana no tiene objetivo de volumen en el plan.'

  const left = targetKm - km
  // A tenth of a kilometre either way is GPS noise, not a verdict.
  if (left > 0.05) return `Faltan ${decimal(left)} km para los ${decimal(targetKm, 0)} previstos.`
  if (left < -0.05)
    return `Objetivo de ${decimal(targetKm, 0)} km cumplido, ${decimal(-left)} km de más.`
  return `Objetivo de ${decimal(targetKm, 0)} km cumplido.`
}

/**
 * The last runs, as a way into their traces — the only route from this screen to
 * `/actividad`, since a day line in `ThisWeek` opens the session rather than the run.
 */
function RecentRuns({
  runs,
  busy,
  onSync,
}: {
  runs: Activity[]
  busy: boolean
  onSync: () => void
}) {
  return (
    <Card className="fade-up">
      <CardTitle
        action={
          // The manual sync lives on the card whose freshness it decides. The webhook and
          // the nightly cron do this on their own; this is the button for the morning they
          // did not.
          <TextLink inset onClick={onSync} disabled={busy}>
            {busy ? 'Sincronizando…' : 'Sincronizar'}
          </TextLink>
        }
      >
        Últimas salidas
      </CardTitle>

      {runs.length === 0 ? (
        <EmptyState>
          Todavía no hay ninguna salida en este bloque. La primera aparecerá aquí en cuanto
          Strava la publique.
        </EmptyState>
      ) : (
        <ul className="divide-y divide-line">
          {runs.map((run) => (
            <li key={run.id}>
              <a
                href={`/actividad?id=${run.id}`}
                className="tappable flex min-h-14 items-center gap-2.5 py-2.5"
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate text-footnote text-label">{run.name}</p>
                  <p className="mt-0.5 text-caption text-label-3">
                    {dayFmt.format(new Date(run.startedOn))}
                    {/* The zone, never the bpm — see the same call in `SessionCard`. */}
                    {run.averageHeartrate ? ` · ${zoneTag(hrZone(run.averageHeartrate))}` : ''}
                    {run.cadenceSpm ? ` · ${run.cadenceSpm} pasos/min` : ''}
                  </p>
                </div>
                <div className="shrink-0 text-right">
                  <p className="data-number text-footnote text-label">
                    {formatKm(run.distanceM)} km
                  </p>
                  <p className="data-number mt-0.5 text-caption text-label-3">
                    {formatPace(paceSKm(run.distanceM, run.movingS))}/km
                  </p>
                </div>
                <Icon path={CHEVRON_RIGHT} className="text-label-4" />
              </a>
            </li>
          ))}
        </ul>
      )}
    </Card>
  )
}

/**
 * The long view, and the second ring on the screen: how much of the block is behind you,
 * with the days left to race in the middle of it.
 *
 * The arc fills while the number counts down, which is the same fact twice rather than two
 * facts — it is a countdown, and a countdown that also shows how far it has come is what
 * the ring is for. The three numbers under it are the ones that say *how* the running has
 * gone rather than how much of it there has been: the hero above already owns volume, and
 * the sentence beside the ring owns whether it is keeping up with the plan.
 */
function RaceCard({ progress, now }: { progress: BlockProgress; now: number }) {
  const { block } = progress
  const days = daysToRace(now)
  const doneKm = block.distanceM / 1000
  const plannedToDateKm =
    progress.plannedToDateM == null ? null : progress.plannedToDateM / 1000
  // Rounded before it is judged: half a kilometre behind is not "por debajo", it is noise.
  const shortfallKm =
    plannedToDateKm == null ? null : Math.max(0, Math.round(plannedToDateKm - doneKm))

  return (
    <Card className="fade-up">
      <CardTitle>Rumbo a la carrera</CardTitle>

      <div className="flex items-center gap-3">
        <ProgressRing
          value={progress.weeksElapsed}
          target={TOTAL_WEEKS}
          size={64}
          label={days}
          sublabel="días"
          ariaLabel={`Faltan ${days} días para la carrera; ${progress.weeksElapsed} de ${TOTAL_WEEKS} semanas del bloque`}
        />
        <div className="min-w-0 flex-1">
          {/* The verdict carries its own words, so the hue is never the only thing saying
              it — mint for on plan, amber for behind, and neither when there is no plan to
              be behind. */}
          <p
            className={cn(
              'text-subhead font-semibold',
              shortfallKm == null ? 'text-label' : shortfallKm === 0 ? 'text-mint' : 'text-amber',
            )}
          >
            {shortfallKm == null
              ? `${progress.weeksElapsed} de ${TOTAL_WEEKS} semanas`
              : shortfallKm === 0
                ? 'Según lo previsto'
                : `${decimal(shortfallKm, 0)} km por debajo`}
          </p>
          <p className="mt-1 text-caption leading-relaxed text-label-3">
            {plannedToDateKm == null
              ? 'El plan aún no fija objetivos de volumen semanal.'
              : `${decimal(doneKm, 0)} km corridos frente a ${decimal(plannedToDateKm, 0)} previstos hasta hoy.`}
          </p>
        </div>
      </div>

      <StatStrip className="mt-3">
        <Stat
          label="Ritmo medio"
          value={block.meanPaceSKm ? `${formatPace(block.meanPaceSKm)}/km` : '—'}
          hint={`objetivo ${formatPace(GOAL_PACE_S_KM)}`}
        />
        <Stat
          label="Más larga"
          value={block.longestM ? `${formatKm(block.longestM)} km` : '—'}
          hint={`de ${decimal(RACE_DISTANCE_M / 1000)} km`}
        />
        <Stat
          label="Cadencia"
          value={block.meanCadenceSpm ? Math.round(block.meanCadenceSpm) : '—'}
          hint="objetivo 170 pasos/min"
        />
      </StatStrip>
    </Card>
  )
}

/**
 * The shape of the screen before its data lands, not the word "Cargando".
 *
 * The first card is built by hand because `LoadingCard`'s generic title-hero-rows shape is
 * not this one — a hero with a ring beside it, a seven-column strip and a stat row. A
 * skeleton that does not match is worse than none, because the card visibly rearranges
 * itself the moment `/api/data` answers. Two cards is the whole sketch: the third and
 * fourth are below the fold on the phone this is drawn for.
 *
 * No `fade-up` on either: the skeleton already breathes, and the real cards fade up as they
 * replace it — two reveals over the same pixels inside half a second is a flicker, not a
 * transition. And the wait announces itself once, on the card that leads it; the second is
 * `aria-hidden`.
 */
function DashboardSkeleton() {
  return (
    <>
      {/* The countdown's own row, held open at its real height. It is the first thing on
          the screen, so a missing 36px here is 36px every card below it jumps by. */}
      <div aria-hidden className="flex items-baseline justify-between gap-2 rounded-xl bg-fill px-3 py-2">
        <Skeleton className="h-2.5 w-24" />
        <Skeleton className="h-4 w-28" />
      </div>
      <Card aria-busy="true" aria-label="Cargando la semana">
        <div className="flex items-center gap-3">
          <div className="min-w-0 flex-1">
            <Skeleton className="h-2.5 w-36" />
            <Skeleton className="mt-2.5 h-8 w-24" />
            <Skeleton className="mt-2.5 h-3 w-48" />
          </div>
          <Skeleton className="size-16 shrink-0 rounded-full" />
        </div>
        <div className="mt-3 flex gap-1">
          {Array.from({ length: 7 }, (_, i) => (
            <Skeleton key={i} className="h-14 flex-1" />
          ))}
        </div>
        <div className="mt-3 grid grid-cols-3 gap-2.5">
          {Array.from({ length: 3 }, (_, i) => (
            <div key={i}>
              <Skeleton className="h-2 w-12" />
              <Skeleton className="mt-1.5 h-4 w-14" />
            </div>
          ))}
        </div>
      </Card>
      <LoadingCard rows={4} hero={false} busy={false} />
    </>
  )
}

/**
 * The screen as the page mounts it: wrapped so a render that throws leaves a card with a
 * way out on it rather than an empty column under the heading. See `Island.tsx`.
 */
export const Dashboard = island(DashboardScreen)
