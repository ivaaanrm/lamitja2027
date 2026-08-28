import { useEffect, useState, type ReactNode } from 'react'
import { goalPaceSKm, startOfDay, totalWeeks, type BlockConfig } from '@/lib/block'
import { cn } from '@/lib/cn'
import { decimal } from '@/lib/format'
import type { WeekMetrics } from '@/lib/metrics'
import { DEFAULT_HR_MAX, paceBands } from '@/lib/paces'
import { setDone, updateWeek } from '@/lib/plan-client'
import type { MatchedSession, WeekPlan } from '@/lib/plan'
import type { PlanSession } from '@/lib/db/schema'
import type { Bands } from '@/lib/workout'
import { PlanAnalysis } from './PlanAnalysis'
import { SessionForm } from './SessionForm'
import { ExtraCard, SessionCard } from './SessionCard'
import { HeaderAvatarLink, NoBlockCard, useBlock } from './useBlock'
import { island } from './Island'
import {
  Button,
  Card,
  Chevron,
  Chip,
  EmptyState,
  ErrorCard,
  Field,
  HeroMetric,
  Icon,
  LoadingCard,
  PLUS,
  ProgressBar,
  ProgressRing,
  Segmented,
  Skeleton,
  TextArea,
  TextInput,
} from './ui'

/**
 * The whole 23-week block, one accordion row per week.
 *
 * A block this long is a navigation problem before it is an editing one. Twenty-three
 * weeks is three phone-screens of list, and until the athlete is looking at the right one
 * nothing else on the page is worth reading — so the screen answers "where am I" twice
 * before it asks for anything: once in the header, as the prescription for the current
 * week, and once in the list, which is grouped by phase and scrolled to that week on
 * arrival, the way a calendar opens on today rather than on January.
 *
 * A week that has not started shows what it *asks for*; a week that has shows what
 * answered it, plus the bar along its bottom edge. Those are different questions and
 * printing "0,0 / 42 km" against next month reads as a week already failed.
 *
 * Every edit writes straight through and re-reads `/api/data`. With a block this small
 * that is a fast round trip, and it means the editor can never drift from what was saved
 * — which matters more here than the few hundred milliseconds an optimistic update saves.
 */

const dayNumFmt = new Intl.DateTimeFormat('es-ES', { day: 'numeric', timeZone: 'UTC' })
// Dates are UTC midnight of the local day; formatting in the viewer's zone slides them.
const dayMonthFmt = new Intl.DateTimeFormat('es-ES', { day: 'numeric', month: 'short', timeZone: 'UTC' })
const weekdayFmt = new Intl.DateTimeFormat('es-ES', { weekday: 'short', day: 'numeric', timeZone: 'UTC' })
const longDayFmt = new Intl.DateTimeFormat('es-ES', {
  weekday: 'long',
  day: 'numeric',
  month: 'long',
  timeZone: 'UTC',
})

/** `17–23 ago`, and `31 ago – 6 sep` on the weeks that straddle two months. */
function weekRange(from: number, to: number): string {
  const start = new Date(from)
  const end = new Date(to)
  return start.getUTCMonth() === end.getUTCMonth()
    ? `${dayNumFmt.format(start)}–${dayMonthFmt.format(end)}`
    : `${dayMonthFmt.format(start)} – ${dayMonthFmt.format(end)}`
}

/**
 * What the week asks for, in metres: its stored target, or failing that whatever its own
 * sessions add up to.
 *
 * The two are the same number by construction — a week's target is the sum of what its
 * sessions prescribe, because "a target no session adds up to is a number that quietly
 * stops meaning anything" — so falling back to the sum is not an estimate, it is the same
 * figure recomputed for a week whose row was never written. Zero when nothing is planned.
 */
function prescribedM(week: WeekPlan, metrics: WeekMetrics): number {
  if (metrics.targetVolumeM != null) return metrics.targetVolumeM
  return week.sessions.reduce((sum, match) => sum + (match.session.targetDistanceM ?? 0), 0)
}

/** Where a week sits relative to today — which decides what its row is allowed to claim. */
type WeekState = 'past' | 'current' | 'future'

interface PhaseGroup {
  phase: string | null
  from: number
  to: number
}

/** Consecutive weeks with the same phase become one visual block. */
function groupPhases(weekly: WeekMetrics[]): PhaseGroup[] {
  return weekly.reduce<PhaseGroup[]>((groups, metrics, index) => {
    const current = groups[groups.length - 1]
    if (current?.phase === metrics.phase) current.to = index
    else groups.push({ phase: metrics.phase, from: index, to: index })
    return groups
  }, [])
}

/**
 * Keeps a panel in the DOM just long enough to animate closed, then removes it.
 *
 * A permanently mounted accordion would make the browser build every session card in all
 * 23 weeks on every visit. Conditional rendering alone avoids that work but can only pop
 * closed, because there is nothing left to animate. This small presence layer gets both:
 * intrinsic-height motion through a 0fr/1fr grid, and no hidden plan tree after it settles.
 */
function CollapsiblePanel({
  id,
  open,
  onOpened,
  children,
}: {
  id: string
  open: boolean
  onOpened?: () => void
  children: ReactNode
}) {
  const [present, setPresent] = useState(open)
  const [expanded, setExpanded] = useState(open)

  useEffect(() => {
    if (open) setPresent(true)
    else setExpanded(false)
  }, [open])

  // The closed frame has to paint once after mounting; otherwise the browser sees a new
  // element already at 1fr and has no previous value to animate from.
  useEffect(() => {
    if (!present || !open || expanded) return
    const frame = requestAnimationFrame(() => setExpanded(true))
    return () => cancelAnimationFrame(frame)
  }, [present, open, expanded])

  return (
    <div
      id={id}
      aria-hidden={!open}
      className={cn(
        'motion-standard grid transition-[grid-template-rows,opacity]',
        expanded ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0',
      )}
      onTransitionEnd={(event) => {
        if (event.target !== event.currentTarget || event.propertyName !== 'grid-template-rows')
          return
        if (open) onOpened?.()
        else setPresent(false)
      }}
    >
      {present ? (
        <div inert={!open} className="min-h-0 overflow-hidden">
          {children}
        </div>
      ) : null}
    </div>
  )
}

function PlannerScreen() {
  const { data, error, now, reload, weeks, progress, currentWeek } = useBlock()
  const [view, setView] = useState<'weeks' | 'analysis'>('weeks')
  const [open, setOpen] = useState<number | null>(null)
  const [editing, setEditing] = useState<{ weekIndex: number; day?: number; session?: PlanSession } | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [jumped, setJumped] = useState(false)

  // Opens on the current week the first time real data arrives, and stays wherever the
  // athlete puts it after that.
  const expanded = open ?? currentWeek

  /**
   * …and scrolls to it, once, on the first payload. By December the current week is a
   * thousand pixels down a list whose first rows are months behind: a plan screen that
   * opens on week 1 is a plan screen you have to fight before you can read it.
   *
   * Three guards keep it from being the wrong kind of clever: it fires once, never after
   * the athlete has opened a week of their own, and never onto a restored scroll offset —
   * `router.tsx` puts a returning tab back where it was left, and yanking the page away
   * from there is worse than opening at the top. That router deliberately zeroes the
   * scroll *before* React renders a route it has no offset for, so the `scrollY` this
   * reads is the one the screen is landing on rather than the one it came from.
   * `document` is read here rather than in the body because this island is also rendered
   * during prerender, in a Worker (AGENTS gotcha 15); the week section owns the `id` it
   * needs.
   */
  useEffect(() => {
    if (jumped || !data || open !== null) return
    setJumped(true)
    if (window.scrollY > 0) return
    document.getElementById(`semana-${currentWeek}`)?.scrollIntoView({ block: 'start' })
  }, [jumped, data, open, currentWeek])

  const navigation = (
    <nav aria-label="Plan" className="fade-up flex items-center gap-2 border-b border-line px-0.5">
      <Segmented<'weeks' | 'analysis'>
        options={[
          { value: 'weeks', label: 'Semanas' },
          { value: 'analysis', label: 'Análisis' },
        ]}
        value={view}
        onChange={setView}
        label="Vista del plan"
        variant="underline"
        className="flex-1"
      />
      <HeaderAvatarLink displayName={data?.user.displayName ?? null} />
    </nav>
  )

  if (error && !data)
    return (
      <>
        {navigation}
        <ErrorCard title="Sin datos del bloque" message={error} onRetry={() => void reload()} />
      </>
    )
  if (!data || !progress)
    return (
      <>
        {navigation}
        <PlannerSkeleton />
      </>
    )
  // No dates yet — `/bienvenida` is the only thing that fixes it, and every number on
  // this screen is counted from them.
  if (!data.block)
    return (
      <>
        {navigation}
        <NoBlockCard />
      </>
    )

  const block = data.block
  const hrMax = data.user.hrMax ?? DEFAULT_HR_MAX
  // A zone is a share of *this* athlete's goal pace, so every band printed below is
  // derived from their block rather than read off the owner's table.
  const bands = paceBands(goalPaceSKm(block))

  async function toggle(match: MatchedSession) {
    setActionError(null)
    try {
      await setDone(match.session.id, !match.done)
      await reload()
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : 'No se pudo guardar')
    }
  }

  const weekly = progress.weekly
  const today = startOfDay(now)
  const phases = groupPhases(weekly)

  function scrollToWeek(weekIndex: number) {
    // The disclosure's transition has settled before this callback. One final frame lets
    // the browser commit that geometry before `scrollIntoView` reads the target position.
    requestAnimationFrame(() => {
      document.getElementById(`semana-${weekIndex}`)?.scrollIntoView({
        block: 'start',
        behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches
          ? 'auto'
          : 'smooth',
      })
    })
  }

  function toggleWeek(weekIndex: number) {
    const opening = weekIndex !== expanded
    setOpen(opening ? weekIndex : -1)
  }

  return (
    <>
      {navigation}

      {view === 'analysis' ? (
        <PlanAnalysis weeks={weeks} />
      ) : (
        <>
          <BlockHeader block={block} week={weeks[currentWeek]!} metrics={weekly[currentWeek]!} />

          <div className="flex flex-col gap-2">
            {phases.map(({ phase, from, to }) => (
              <section
                key={`${from}-${phase ?? 'sin-fase'}`}
                aria-labelledby={phase ? `fase-${from}` : undefined}
                className="overflow-hidden rounded-2xl bg-fill"
              >
                {/* A phase name repeated down seven consecutive rows is six rows of noise; said
                    once, inside the surface it owns, it is the map of the whole 23 weeks. */}
                {phase ? (
                  <PhaseHeading id={`fase-${from}`} phase={phase} from={from} to={to} />
                ) : null}

                <div className="divide-y divide-line">
                  {weeks.slice(from, to + 1).map((week, offset) => {
                    const i = from + offset
                    const metrics = weekly[i]!
                    return (
                      <WeekRow
                        key={week.weekIndex}
                        week={week}
                        metrics={metrics}
                        index={i}
                        today={today}
                        hrMax={hrMax}
                        bands={bands}
                        state={
                          week.weekIndex === currentWeek
                            ? 'current'
                            : week.weekIndex < currentWeek
                              ? 'past'
                              : 'future'
                        }
                        isOpen={week.weekIndex === expanded}
                        onOpen={() => toggleWeek(week.weekIndex)}
                        onOpened={() => scrollToWeek(week.weekIndex)}
                        onReload={reload}
                        onToggle={toggle}
                        onEdit={(session) =>
                          setEditing({ weekIndex: week.weekIndex, session })
                        }
                        onAdd={(day) => setEditing({ weekIndex: week.weekIndex, day })}
                        onError={setActionError}
                      />
                    )
                  })}
                </div>
              </section>
            ))}
          </div>

          {actionError ? (
            <p role="alert" className="text-center text-caption text-red">
              {actionError}
            </p>
          ) : null}

          {editing ? (
            <SessionForm
              block={block}
              weekIndex={editing.weekIndex}
              session={editing.session}
              defaultDay={editing.day}
              onSaved={reload}
              onClose={() => setEditing(null)}
            />
          ) : null}
        </>
      )}
    </>
  )
}

/**
 * What this week asks for, before the list of 23 asks anything.
 *
 * The one hero on the screen, and it is deliberately the *prescription* rather than the
 * distance already run: `/plan` is where the plan is read and edited, and "how far have I
 * got" is the question `/` opens with. The ring beside it is the one share this card is
 * about — sessions ticked off — which is a ring and not a bar by the same rule.
 */
function BlockHeader({
  block,
  week,
  metrics,
}: {
  block: BlockConfig
  week: WeekPlan
  metrics: WeekMetrics
}) {
  const targetKm = prescribedM(week, metrics) / 1000
  const planned = metrics.sessionsPlanned

  return (
    <Card className="fade-up">
      <HeroMetric
        eyebrow={`Semana ${metrics.weekIndex + 1} de ${totalWeeks(block)}`}
        value={decimal(targetKm, 0)}
        unit="km previstos"
        context={
          planned === 0
            ? 'Esta semana todavía no tiene ninguna sesión escrita.'
            : [metrics.phase, `${planned} ${planned === 1 ? 'sesión' : 'sesiones'}`]
                .filter(Boolean)
                .join(' · ')
        }
        trailing={
          planned > 0 ? (
            <ProgressRing
              value={metrics.sessionsDone}
              target={planned}
              label={`${metrics.sessionsDone}/${planned}`}
              sublabel="hechas"
              ariaLabel={`${metrics.sessionsDone} de ${planned} sesiones hechas esta semana`}
            />
          ) : null
        }
      />
    </Card>
  )
}

/** The block's own structure, printed where it changes: `BASE Y VOLUMEN · S1–S6`. */
function PhaseHeading({
  id,
  phase,
  from,
  to,
}: {
  id: string
  phase: string
  from: number
  to: number
}) {
  return (
    <h2
      id={id}
      className="px-3 pb-1 pt-2.5 text-caption2 font-semibold uppercase tracking-[0.12em] text-label-2"
    >
      {phase}
      <span className="data-number font-normal text-label-3">
        {' · '}
        {from === to ? `S${from + 1}` : `S${from + 1}–S${to + 1}`}
      </span>
    </h2>
  )
}

function WeekRow({
  week,
  metrics,
  index,
  state,
  isOpen,
  today,
  hrMax,
  bands,
  onOpen,
  onOpened,
  onReload,
  onToggle,
  onEdit,
  onAdd,
  onError,
}: {
  week: WeekPlan
  metrics: WeekMetrics
  /** Position in the rendered list — the reveal stagger, nothing else. */
  index: number
  state: WeekState
  isOpen: boolean
  /** UTC midnight of the current local day. */
  today: number
  /** The athlete's max HR, resolved once by the screen — `user.hrMax ?? DEFAULT_HR_MAX`. */
  hrMax: number
  /** The athlete's own six pace bands, resolved once by the screen from their goal pace. */
  bands: Bands
  onOpen: () => void
  onOpened: () => void
  onReload: () => Promise<void>
  onToggle: (match: MatchedSession) => void
  onEdit: (session: PlanSession) => void
  onAdd: (day: number) => void
  onError: (message: string | null) => void
}) {
  const km = metrics.totals.distanceM / 1000
  const asked = prescribedM(week, metrics)
  const targetKm = asked > 0 ? asked / 1000 : null
  const started = state !== 'future'
  // A share incidental to a row in a list is a bar, not a ring — and a week nobody has
  // run yet has no share to report, so it gets no track either.
  const showBar = started && targetKm != null
  const hasContent = week.sessions.length > 0 || week.extras.length > 0
  // Opening the sheet on a day that is already full is one extra tap on the picker every
  // time; the first free day of the week is nearly always the one meant.
  const addDay = (week.days.find((day) => day.sessions.length === 0) ?? week.days[0]!).date

  return (
    <section
      id={`semana-${week.weekIndex}`}
      // Body padding protects only the document's first paint and scrolls away. Every
      // programmatic week focus needs its own notch inset, plus the normal page gutter so
      // the row reads as deliberately placed rather than merely not clipped.
      className="fade-up scroll-mt-[calc(env(safe-area-inset-top)+var(--spacing-gutter))] overflow-hidden"
      style={{ animationDelay: `${Math.min(index, 7) * 30}ms` }}
    >
      <button
        type="button"
        onClick={onOpen}
        aria-expanded={isOpen}
        aria-controls={`contenido-semana-${week.weekIndex}`}
        className={cn(
          'tappable flex min-h-14 w-full items-center gap-2.5 px-3 py-2.5 text-left focus-visible:bg-fill-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent',
          isOpen && 'bg-fill',
        )}
      >
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5">
            <span className="data-number text-footnote font-semibold text-label">
              S{week.weekIndex + 1}
            </span>
            {/* State is written as well as coloured, so "which week is now" never depends
                on a decorative container or colour perception alone. */}
            {state === 'current' ? (
              <span className="text-caption2 font-semibold uppercase tracking-[0.12em] text-accent">
                Ahora
              </span>
            ) : null}
            {metrics.isDownWeek ? <Chip tone="down">Descarga</Chip> : null}
          </span>
          <span className="mt-0.5 block truncate text-caption text-label-3">
            {weekRange(week.days[0]!.date, week.days[6]!.date)}
          </span>
        </span>

        <span className="shrink-0 text-right">
          <span className="data-number block text-footnote text-label">
            {started ? (
              <>
                {decimal(km)}
                {targetKm != null ? <span className="text-label-3"> / {decimal(targetKm, 0)}</span> : null}
                <span className="ml-1 text-caption font-normal text-label-3">km</span>
              </>
            ) : targetKm != null ? (
              <>
                {decimal(targetKm, 0)}
                <span className="ml-1 text-caption font-normal text-label-3">km</span>
              </>
            ) : (
              <span className="text-label-3">—</span>
            )}
          </span>
          {metrics.sessionsPlanned > 0 ? (
            <span className="mt-0.5 block text-caption tabular-nums text-label-3">
              {started
                ? `${metrics.sessionsDone}/${metrics.sessionsPlanned} sesiones`
                : `${metrics.sessionsPlanned} ${metrics.sessionsPlanned === 1 ? 'sesión prevista' : 'sesiones previstas'}`}
            </span>
          ) : null}
        </span>

        <Chevron open={isOpen} />
      </button>

      {/* Full-width on the list edge rather than inset above it: at 23 rows an inset bar
          costs a whole extra line of padding per week, and read as a rule it also separates
          the header from what unfolds under it. */}
      {showBar ? <ProgressBar value={km} target={targetKm} className="h-1 rounded-none" /> : null}

      <CollapsiblePanel
        id={`contenido-semana-${week.weekIndex}`}
        open={isOpen}
        onOpened={onOpened}
      >
        <div className={cn('px-3 pb-3 pt-2.5', !showBar && 'border-t border-line')}>
          {hasContent ? (
            <>
              <div className="space-y-2">
                {week.days.map((day) =>
                  day.sessions.length === 0 && day.extras.length === 0 ? (
                    <EmptyDay
                      key={day.date}
                      date={day.date}
                      isToday={day.date === today}
                      onAdd={() => onAdd(day.date)}
                    />
                  ) : (
                    <div key={day.date}>
                      <DayLabel date={day.date} isToday={day.date === today} />
                      <div className="mt-1 space-y-1.5">
                        {day.sessions.map((match) => (
                          <SessionCard
                            key={match.session.id}
                            match={match}
                            hrMax={hrMax}
                            bands={bands}
                            onToggle={match.activity ? undefined : () => onToggle(match)}
                            onEdit={() => onEdit(match.session)}
                          />
                        ))}
                        {day.extras.map((activity) => (
                          <ExtraCard key={activity.id} activity={activity} />
                        ))}
                      </div>
                    </div>
                  ),
                )}
              </div>

              {/* The per-day affordance is the empty row above; this one exists for the
                  double days, where every row is already taken. */}
              <Button className="mt-2.5 w-full" onClick={() => onAdd(addDay)}>
                Añadir sesión
              </Button>
            </>
          ) : (
            <EmptyState
              action={
                <Button variant="primary" onClick={() => onAdd(addDay)}>
                  Añadir sesión
                </Button>
              }
            >
              Esta semana no tiene ninguna sesión escrita todavía.
            </EmptyState>
          )}

          <WeekFields week={week} onReload={onReload} onError={onError} />
        </div>
      </CollapsiblePanel>
    </section>
  )
}

/** `LUN 17`, and accent plus the word on the one day that is today. */
function DayLabel({ date, isToday }: { date: number; isToday: boolean }) {
  return (
    <p
      className={cn(
        'px-0.5 text-caption2 font-medium uppercase tracking-[0.09em]',
        isToday ? 'text-accent' : 'text-label-3',
      )}
    >
      {weekdayFmt.format(new Date(date))}
      {isToday ? ' · hoy' : ''}
    </p>
  )
}

/**
 * A day with nothing on it, as one 44px row that is also the way to fill it.
 *
 * The alternative — a heading and an "Añadir" link on all seven days — is fourteen
 * elements to say a week has three sessions in it. Here an empty day states itself and
 * carries its own action, so the week reads as a calendar rather than as a form.
 */
function EmptyDay({
  date,
  isToday,
  onAdd,
}: {
  date: number
  isToday: boolean
  onAdd: () => void
}) {
  return (
    <button
      type="button"
      onClick={onAdd}
      aria-label={`Añadir sesión el ${longDayFmt.format(new Date(date))}`}
      className="tappable flex min-h-11 w-full items-center gap-2 rounded-xl px-2 text-left"
    >
      <span
        className={cn(
          'w-16 shrink-0 text-caption2 font-medium uppercase tracking-[0.09em]',
          isToday ? 'text-accent' : 'text-label-3',
        )}
      >
        {weekdayFmt.format(new Date(date))}
      </span>
      <span className="flex-1 text-footnote text-label-3">Sin sesión</span>
      <Icon path={PLUS} className="text-label-3" />
    </button>
  )
}

/**
 * Phase, focus and volume target for one week. Saved on blur — there is no Save button to
 * forget, and a stray keystroke costs one request.
 *
 * It sits *under* the sessions rather than over them: what a week asks of you is what the
 * row was opened for, and four form controls between the tap and the plan is a filing
 * cabinet where a calendar should be.
 */
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
    <div className="mt-2.5 space-y-2 border-t border-line pt-2.5">
      {/* `label-3`, the same step the field labels wear: this names a region of four
          controls, and a heading a step brighter than everything it heads is the one
          element in a settings block that reads as loud. */}
      <p className="text-caption2 font-semibold uppercase tracking-[0.12em] text-label-3">
        Ajustes de la semana
      </p>

      <div className="grid grid-cols-2 gap-2">
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

      {/* A textarea, not a one-line input: a phase focus is a sentence — "Todo suave, en
          llano y a sensaciones. Cuatro carreras, cadencia y fuerza de cadera desde el
          primer día." — and a slot that shows the first thirty characters of it is a field
          you have to scrub through to read what you wrote. It grows to its content. */}
      <Field label="Enfoque">
        <TextArea
          value={focus}
          placeholder="1 sesión de calidad, tirada larga hasta 16 km"
          onChange={(e) => setFocus(e.target.value)}
          onBlur={() => void save({ focus: focus.trim() || null })}
        />
      </Field>

      {/* Two named states rather than a button whose label is also its value: "Marcar como
          semana de descarga" never says which of the two it currently is. `Field` is not
          the wrapper here because it renders a `<label>`, and a label has to point at a
          labelable control — `Segmented` is a tablist of buttons. */}
      <div>
        <span className="text-caption2 uppercase tracking-[0.09em] text-label-3">
          Volumen de la semana
        </span>
        <div className="mt-0.5">
          <Segmented<'normal' | 'down'>
            options={[
              { value: 'normal', label: 'Carga normal' },
              { value: 'down', label: 'Descarga' },
            ]}
            value={isDownWeek ? 'down' : 'normal'}
            onChange={(next) => {
              // Tapping the option already selected is not an edit, and every edit here
              // costs a write plus a re-read of the whole block.
              if ((next === 'down') !== isDownWeek) void save({ isDownWeek: next === 'down' })
            }}
          />
        </div>
      </div>
    </div>
  )
}

/**
 * The shape of the screen that is coming: the header card, then a phase list.
 *
 * Not `LoadingCard` repeated — a week row is two short columns and a hairline, not a
 * title-plus-hero-plus-rows, and a skeleton that guesses the wrong shape makes the list
 * visibly rearrange itself the moment the payload lands.
 *
 * No `fade-up` and no stagger on any of them: the skeleton already breathes, and the real
 * rows fade up as they replace it. Two reveals over the same pixels inside half a second is
 * a flicker, not a transition. Only the header card announces the wait; the rows behind it
 * are `aria-hidden`, because six "Cargando" regions is six announcements of one fetch.
 */
function PlannerSkeleton() {
  return (
    <>
      <LoadingCard rows={1} />
      <div aria-hidden className="overflow-hidden rounded-2xl bg-fill">
        <div className="px-3 pb-1 pt-2.5">
          <Skeleton className="h-2.5 w-28" />
        </div>
        <div className="divide-y divide-line">
          {Array.from({ length: 6 }, (_, i) => (
            <div key={i} className="min-h-14 px-3 py-2.5">
              <div className="flex items-start justify-between gap-3">
                <div className="space-y-1.5">
                  <Skeleton className="h-3 w-8" />
                  <Skeleton className="h-2.5 w-20" />
                </div>
                <div className="flex flex-col items-end space-y-1.5">
                  <Skeleton className="h-3 w-20" />
                  <Skeleton className="h-2.5 w-16" />
                </div>
              </div>
              <Skeleton className="mt-2.5 h-1 w-full" />
            </div>
          ))}
        </div>
      </div>
    </>
  )
}

/**
 * The screen as the page mounts it: wrapped so a render that throws leaves a card with a
 * way out on it rather than an empty column under the heading. See `Island.tsx`.
 */
export const Planner = island(PlannerScreen)
