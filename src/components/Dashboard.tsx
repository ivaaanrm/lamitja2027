import { useEffect, useState } from 'react'
import { formatClock, formatDuration, formatKm, formatPace, isRun, paceSKm } from '@/lib/activity'
import { daysToRace, goalPaceSKm, startOfDay, totalWeeks, type BlockConfig } from '@/lib/block'
import { cn } from '@/lib/cn'
import type { Activity } from '@/lib/db/schema'
import { decimal } from '@/lib/format'
import type { BlockProgress, WeekMetrics } from '@/lib/metrics'
import { DEFAULT_HR_MAX, hrZone, paceBands, zoneTag } from '@/lib/paces'
import type { MatchedSession, WeekPlan } from '@/lib/plan'
import { setDone } from '@/lib/plan-client'
import { ThisWeek } from './ThisWeek'
import { WeekCalendar } from './WeekCalendar'
import { NoBlockCard, useBlock } from './useBlock'
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

/**
 * What `/api/strava/callback` bounced back with.
 *
 * The browser arrives there from Strava's own domain with no island waiting on a response,
 * so the callback redirects to `/?strava=…` and this is the only place the outcome is ever
 * said. `ok` is deliberately absent: a connect that worked is announced by the activities
 * showing up, and a green banner on top of them would be the app congratulating itself.
 */
const STRAVA_OUTCOME: Record<string, string> = {
  error: 'Strava no ha podido completar la conexión. Inténtalo otra vez.',
  bad_state: 'El enlace de conexión ha caducado. Vuelve a empezar desde aquí.',
  scope: 'Falta el permiso para leer las actividades privadas. Acéptalo en Strava o los kilómetros saldrán incompletos.',
  taken: 'Esa cuenta de Strava ya está conectada a otro atleta.',
}

function DashboardScreen() {
  const { data, error, now, reload, weeks, progress, currentWeek } = useBlock()
  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const [stravaNotice, setStravaNotice] = useState<string | null>(null)

  // Read in an effect and never in the body: this island is also rendered during the
  // prerender pass, inside a Worker where there is no `location` (AGENTS gotcha 15).
  useEffect(() => {
    const outcome = new URLSearchParams(location.search).get('strava') ?? ''
    setStravaNotice(STRAVA_OUTCOME[outcome] ?? null)
  }, [])

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
  // No dates yet — `/bienvenida` is the only thing that fixes it, and every number on
  // this screen is counted from them.
  if (!data.block) return <NoBlockCard />


  if (!data.stravaConnected) {
    return (
      <Card className="fade-up">
        <CardTitle>Strava</CardTitle>
        {stravaNotice ? (
          <p role="alert" className="mb-2 text-footnote leading-relaxed text-red">
            {stravaNotice}
          </p>
        ) : null}
        <EmptyState
          action={
            // The application accent is Strava's own orange, so this connection action
            // and every primary state resolve through the same token.
            <a
              href="/api/strava/connect"
              className="tappable inline-flex h-11 items-center justify-center rounded-xl bg-accent px-5 text-footnote font-semibold text-surface"
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

  const block = data.block
  const hrMax = data.user.hrMax ?? DEFAULT_HR_MAX
  // A zone is a share of *this* athlete's goal pace — see the same line in `Planner`.
  const bands = paceBands(goalPaceSKm(block))
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
      {/* Above everything, because it answers the tap that landed here. Only ever drawn
          for a connect that went wrong — a connect that worked is said by the kilometres. */}
      {stravaNotice ? (
        <Card className="fade-up">
          <p role="alert" className="text-footnote leading-relaxed text-red">
            {stravaNotice}
          </p>
        </Card>
      ) : null}
      <RaceCountdown block={block} now={now} />
      <WeekHero block={block} metrics={metrics} week={week} today={today} notStarted={now < block.startsOn} />
      <ThisWeek week={week} today={today} hrMax={hrMax} bands={bands} onToggle={toggle} />
      <RecentRuns runs={recent} hrMax={hrMax} busy={busy} onSync={() => void sync()} />
      <RaceCard block={block} progress={progress} now={now} />

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
/**
 * Two filled glyphs, drawn here rather than through `Icon` (ui/index.tsx) because that
 * wrapper is stroke-only — an outlined flag beside an outlined ring reads as chrome, and
 * the point of these two is that they are the block's *destination*, so they are solid and
 * accent. `evenodd` is what carves the ring out of the target's disc in one path.
 */
const FLAG_SOLID =
  'M6 2a1 1 0 0 1 1 1v18a1 1 0 0 1-2 0V3a1 1 0 0 1 1-1ZM7 3h11a.5.5 0 0 1 .4.8L16 8l2.4 4.2a.5.5 0 0 1-.4.8H7V3Z'
const TARGET_SOLID =
  'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm0 4a6 6 0 1 0 0 12 6 6 0 0 0 0-12Zm0 3a3 3 0 1 0 0 6 3 3 0 0 0 0-6Z'

function SolidIcon({ path, className }: { path: string; className?: string }) {
  return (
    <svg
      aria-hidden
      viewBox="0 0 24 24"
      fill="currentColor"
      fillRule="evenodd"
      clipRule="evenodd"
      className={cn('size-3.5 shrink-0', className)}
    >
      <path d={path} />
    </svg>
  )
}

/**
 * The block's target line, folded into the countdown it counts toward: how many days are
 * left, and — under it — the two things those days are *for*, the race and the goal time.
 * Both carry a filled accent glyph because accent here is not decoration but the destination
 * the whole screen is oriented at; the values stay `text-label` so the colour is the
 * marker and the fact is the ink.
 */
function RaceCountdown({ block, now }: { block: BlockConfig; now: number }) {
  const days = daysToRace(block, now)
  const weeks = Math.floor(days / 7)

  return (
    <div className="rounded-xl bg-fill px-3 py-2.5">
      <div className="flex items-baseline justify-between gap-2">
        <p className="text-caption2 font-semibold uppercase tracking-[0.16em] text-label-3">
          Cuenta atrás
        </p>
        {days === 0 ? (
          <p className="shrink-0 text-footnote font-semibold text-accent">Hoy es la carrera</p>
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
      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-caption text-label-2">
        <span className="flex min-w-0 items-center gap-1.5">
          <SolidIcon path={FLAG_SOLID} className="text-accent" />
          <span className="truncate font-medium text-label">{block.raceName}</span>
        </span>
        <span className="flex items-center gap-1.5">
          <SolidIcon path={TARGET_SOLID} className="text-accent" />
          <span className="data-number font-semibold text-label">{formatClock(block.goalTimeS)}</span>
        </span>
      </div>
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
  block,
  metrics,
  week,
  today,
  notStarted,
}: {
  block: BlockConfig
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
            ? `El bloque abre el ${dayFmt.format(new Date(block.startsOn))}`
            : `Semana ${metrics.weekIndex + 1} de ${totalWeeks(block)}${qualifier ? ` · ${qualifier}` : ''}`
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
  hrMax,
  busy,
  onSync,
}: {
  runs: Activity[]
  hrMax: number
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
                    {run.averageHeartrate ? ` · ${zoneTag(hrZone(run.averageHeartrate, hrMax))}` : ''}
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
function RaceCard({
  block,
  progress,
  now,
}: {
  block: BlockConfig
  progress: BlockProgress
  now: number
}) {
  const days = daysToRace(block, now)
  const doneKm = progress.block.distanceM / 1000
  const plannedToDateKm =
    progress.plannedToDateM == null ? null : progress.plannedToDateM / 1000
  // Rounded before it is judged: half a kilometre behind is not "por debajo", it is noise.
  const shortfallKm =
    plannedToDateKm == null ? null : Math.max(0, Math.round(plannedToDateKm - doneKm))
  const weeks = totalWeeks(block)

  return (
    <Card className="fade-up">
      <CardTitle>Rumbo a la carrera</CardTitle>

      <div className="flex items-center gap-3">
        <ProgressRing
          value={progress.weeksElapsed}
          target={weeks}
          size={64}
          label={days}
          sublabel="días"
          ariaLabel={`Faltan ${days} días para la carrera; ${progress.weeksElapsed} de ${weeks} semanas del bloque`}
        />
        <div className="min-w-0 flex-1">
          {/* The verdict carries its own words, so the hue is never the only thing saying
              it — accent for on plan, amber for behind, and neither when there is no plan to
              be behind. */}
          <p
            className={cn(
              'text-subhead font-semibold',
              shortfallKm == null ? 'text-label' : shortfallKm === 0 ? 'text-accent' : 'text-amber',
            )}
          >
            {shortfallKm == null
              ? `${progress.weeksElapsed} de ${weeks} semanas`
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
          value={progress.block.meanPaceSKm ? `${formatPace(progress.block.meanPaceSKm)}/km` : '—'}
          hint={`objetivo ${formatPace(goalPaceSKm(block))}`}
        />
        <Stat
          label="Más larga"
          value={progress.block.longestM ? `${formatKm(progress.block.longestM)} km` : '—'}
          hint={`de ${decimal(block.raceDistanceM / 1000)} km`}
        />
        <Stat
          label="Cadencia"
          value={progress.block.meanCadenceSpm ? Math.round(progress.block.meanCadenceSpm) : '—'}
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
