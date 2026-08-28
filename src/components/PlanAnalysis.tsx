import { useMemo, useState, type ReactNode } from 'react'
import { cn } from '@/lib/cn'
import { decimal } from '@/lib/format'
import {
  DEFAULT_PLAN_ANALYSIS_FILTERS,
  filterPlanAnalysis,
  planAnalysisRows,
  summarizePlanAnalysis,
  type PlanAnalysisSort,
} from '@/lib/plan-analysis'
import { SESSION_META, SESSION_TYPES, type SessionType, type WeekPlan } from '@/lib/plan'
import {
  Card,
  CardTitle,
  EmptyState,
  Field,
  Select,
  Stat,
  StatStrip,
  TextInput,
  TextLink,
  TypeChip,
} from './ui'

const dateFmt = new Intl.DateTimeFormat('es-ES', {
  day: 'numeric',
  month: 'short',
  timeZone: 'UTC',
})

const SORT_OPTIONS: { value: PlanAnalysisSort; label: string }[] = [
  { value: 'plan', label: 'Orden del plan' },
  { value: 'distance-desc', label: 'Más distancia primero' },
  { value: 'distance-asc', label: 'Menos distancia primero' },
]

/** `12,5` and `12.5` both become metres; a half-typed value remains unbounded. */
function parseDistanceM(value: string): number | null {
  if (!value.trim()) return null
  const km = Number(value.replace(',', '.'))
  return Number.isFinite(km) && km >= 0 ? km * 1000 : null
}

/**
 * The whole written block at scanning resolution.
 *
 * This view never fetches and never queries: `Planner` already owns every row belonging
 * to the signed-in athlete, matched and grouped into weeks. Flattening that value makes
 * the switch instant, keeps it useful offline and leaves the cross-athlete invariant at
 * the same `/api/data` boundary that protects the rest of the screen.
 */
export function PlanAnalysis({ weeks }: { weeks: WeekPlan[] }) {
  const [type, setType] = useState<SessionType | null>(null)
  const [phase, setPhase] = useState<string | null>(null)
  const [minKm, setMinKm] = useState('')
  const [maxKm, setMaxKm] = useState('')
  const [sort, setSort] = useState<PlanAnalysisSort>('plan')

  const rows = useMemo(() => planAnalysisRows(weeks), [weeks])
  const types = useMemo(() => {
    const present = new Set(rows.map((row) => row.session.type))
    return SESSION_TYPES.filter((sessionType) => present.has(sessionType))
  }, [rows])
  const phases = useMemo(
    () => [...new Set(rows.map((row) => row.phase).filter((item): item is string => item != null))],
    [rows],
  )

  const visible = useMemo(
    () =>
      filterPlanAnalysis(rows, {
        type,
        phase,
        minDistanceM: parseDistanceM(minKm),
        maxDistanceM: parseDistanceM(maxKm),
        sort,
      }),
    [rows, type, phase, minKm, maxKm, sort],
  )
  const summary = useMemo(() => summarizePlanAnalysis(visible), [visible])
  const filtered =
    type != null || phase != null || minKm !== '' || maxKm !== '' || sort !== 'plan'

  function reset() {
    setType(DEFAULT_PLAN_ANALYSIS_FILTERS.type)
    setPhase(DEFAULT_PLAN_ANALYSIS_FILTERS.phase)
    setMinKm('')
    setMaxKm('')
    setSort(DEFAULT_PLAN_ANALYSIS_FILTERS.sort)
  }

  return (
    <>
      <Card className="fade-up">
        <CardTitle>Resumen filtrado</CardTitle>
        <StatStrip>
          <Stat label="Sesiones" value={summary.sessionCount} hint="previstas" />
          <Stat
            label="Distancia"
            value={decimal(summary.distanceM / 1000)}
            hint="km previstos"
          />
          <Stat label="Semanas" value={summary.weekCount} hint="con sesiones" />
        </StatStrip>
      </Card>

      <Card className="fade-up" style={{ animationDelay: '30ms' }}>
        <CardTitle
          action={
            filtered ? (
              <TextLink onClick={reset} inset>
                Limpiar
              </TextLink>
            ) : null
          }
        >
          Filtros
        </CardTitle>

        <div className="grid grid-cols-2 gap-2">
          <Field label="Tipo">
            <Select
              value={type ?? ''}
              onChange={(event) =>
                setType(event.target.value ? (event.target.value as SessionType) : null)
              }
            >
              <option value="">Todos</option>
              {types.map((sessionType) => (
                <option key={sessionType} value={sessionType}>
                  {SESSION_META[sessionType].label}
                </option>
              ))}
            </Select>
          </Field>

          <Field label="Fase">
            <Select
              value={phase ?? ''}
              onChange={(event) => setPhase(event.target.value || null)}
            >
              <option value="">Todas</option>
              {phases.map((item) => (
                <option key={item} value={item}>
                  {item}
                </option>
              ))}
            </Select>
          </Field>

          <Field label="Desde (km)">
            <TextInput
              inputMode="decimal"
              value={minKm}
              placeholder="0"
              onChange={(event) => setMinKm(event.target.value)}
            />
          </Field>

          <Field label="Hasta (km)">
            <TextInput
              inputMode="decimal"
              value={maxKm}
              placeholder="Sin límite"
              onChange={(event) => setMaxKm(event.target.value)}
            />
          </Field>

          <div className="col-span-2">
            <Field label="Ordenar">
              <Select
                value={sort}
                onChange={(event) => setSort(event.target.value as PlanAnalysisSort)}
              >
                {SORT_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
        </div>
      </Card>

      <Card
        className="fade-up overflow-hidden px-0 py-0"
        style={{ animationDelay: '60ms' }}
      >
        <div className="px-3 pt-2.5">
          <CardTitle
            action={
              <span aria-live="polite" className="data-number text-caption text-label-3">
                {visible.length} de {rows.length}
              </span>
            }
          >
            Sesiones previstas
          </CardTitle>
        </div>

        {visible.length > 0 ? (
          <div>
            {/* A semantic table whose rows become a three-column, two-line grid below the
                desktop breakpoint. The data stays one tree — no duplicated mobile list —
                while the phone never has to pan sideways to reach the distance. */}
            <table className="block w-full table-fixed sm:table">
              <thead className="hidden sm:table-header-group">
                <tr>
                  <ColumnHeading className="w-14">Semana</ColumnHeading>
                  <ColumnHeading className="w-[4.5rem]">Fecha</ColumnHeading>
                  <ColumnHeading className="w-[4.75rem]">Tipo</ColumnHeading>
                  <ColumnHeading>Sesión</ColumnHeading>
                  <ColumnHeading className="w-20 text-right">Distancia</ColumnHeading>
                </tr>
              </thead>
              <tbody className="block divide-y divide-line sm:table-row-group">
                {visible.map((row) => {
                  const { session } = row
                  return (
                    <tr
                      key={`${session.userId}-${session.id}`}
                      className="grid min-h-16 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-2 gap-y-1 px-3 py-2.5 sm:table-row sm:min-h-0 sm:px-0 sm:py-0"
                    >
                      <td className="col-start-1 row-start-1 sm:table-cell sm:px-3 sm:py-2.5 sm:align-middle">
                        <span className="data-number block text-footnote font-semibold text-label">
                          S{row.weekIndex + 1}
                        </span>
                        {row.phase ? (
                          <span className="hidden truncate text-caption2 text-label-3 sm:block">
                            {row.phase}
                          </span>
                        ) : null}
                      </td>
                      <td className="col-span-2 col-start-2 row-start-1 text-right sm:table-cell sm:px-3 sm:py-2.5 sm:text-left sm:align-middle">
                        <span className="data-number text-caption text-label-3">
                          {dateFmt.format(new Date(session.scheduledOn))}
                        </span>
                      </td>
                      <td className="col-start-1 row-start-2 sm:table-cell sm:px-3 sm:py-2.5 sm:align-middle">
                        <TypeChip type={session.type} />
                      </td>
                      <td className="col-start-2 row-start-2 min-w-0 sm:table-cell sm:px-3 sm:py-2.5 sm:align-middle">
                        <a
                          href={`/sesion?id=${encodeURIComponent(session.id)}&desde=plan`}
                          className="tappable -my-2 flex min-h-11 items-center text-footnote font-medium leading-snug text-label active:text-label-2 sm:my-0 sm:min-h-0"
                        >
                          <span className="line-clamp-2">{session.title}</span>
                        </a>
                      </td>
                      <td className="col-start-3 row-start-2 text-right sm:table-cell sm:px-3 sm:py-2.5 sm:align-middle">
                        <span
                          className={cn(
                            'data-number whitespace-nowrap text-footnote font-semibold',
                            session.targetDistanceM == null ? 'text-label-3' : 'text-label',
                          )}
                        >
                          {session.targetDistanceM == null
                            ? '—'
                            : `${decimal(session.targetDistanceM / 1000)} km`}
                        </span>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="px-3 py-3">
            <EmptyState
              action={
                filtered ? (
                  <TextLink onClick={reset} tone="primary">
                    Quitar filtros
                  </TextLink>
                ) : null
              }
            >
              {rows.length === 0
                ? 'Todavía no hay sesiones escritas en el plan.'
                : 'Ninguna sesión coincide con estos filtros.'}
            </EmptyState>
          </div>
        )}
      </Card>
    </>
  )
}

function ColumnHeading({
  children,
  className,
}: {
  children: ReactNode
  className?: string
}) {
  return (
    <th
      scope="col"
      className={cn(
        'px-3 py-2 text-left text-caption2 font-semibold uppercase tracking-[0.09em] text-label-3',
        className,
      )}
    >
      {children}
    </th>
  )
}
