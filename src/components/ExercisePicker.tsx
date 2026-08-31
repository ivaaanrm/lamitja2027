import { useEffect, useState } from 'react'
import { cn } from '@/lib/cn'
import { categoryLabel, difficultyLabel, equipmentLabel } from '@/lib/exercise-labels'
import { ApiError, getExercise, searchExercises, type ExerciseHit } from '@/lib/plan-client'
import type { CatalogExercise } from '@/lib/exercises/catalog'
import type { StrengthExercise } from '@/lib/strength'
import { ExerciseThumb, RepdbAttribution } from './exercise-ui'
import { Sheet } from './Sheet'
import { CHEVRON_DOWN, Icon, TextInput } from './ui'

/**
 * The catalogue, as a search box — which is all it is ever allowed to be.
 *
 * 571 illustrated moves live in the Worker (`src/lib/exercises/`, ~650 KB of vendored
 * Spanish prose) and never reach the browser. This sheet asks them a question over
 * `GET /api/exercises` and gets back at most fifty trimmed rows. That shape is a licence
 * term rather than a tuning: RepDB's Free Tier permits in-app use and forbids
 * redistribution *as a dataset*, so there is no request this endpoint answers with
 * everything, no cursor to walk it with, and the prose comes back one record at a time
 * from `/api/exercises/[id]` — which is what the disclosure below fetches, on the row
 * somebody is actually looking at.
 *
 * The endpoint refuses a query with fewer than two letters and no facet, so nothing is
 * fetched until there is something to ask. An empty picker states the four filters instead
 * of an empty result list, because "no encontrado" and "todavía no has preguntado" are the
 * same blank screen and different facts.
 *
 * Tapping a row adds it and closes: a picker that lets you add nine moves without leaving
 * is a picker you have to remember the state of. Nine taps, nine returns, and the list you
 * are building is on the screen behind it the whole time.
 */

/** The chips, in the order a rebuild actually reaches for them. */
const FILTERS = [
  { key: 'bodyweight', label: 'Sin material', query: { bodyweight: true } },
  { key: 'knee', label: 'Apta para rodilla', query: { tag: 'knee_safe' } },
  { key: 'core', label: 'Core', query: { bodyPart: 'core' } },
  { key: 'mobility', label: 'Movilidad', query: { tag: 'mobility' } },
] as const

type FilterKey = (typeof FILTERS)[number]['key']

/**
 * What a freshly picked row becomes.
 *
 * Three series of ten with a minute between them is the honest default for a strength
 * move — it is what almost every row in the two built-in templates starts from — and a
 * stretch is measured in seconds instead, because a hold has no repetitions. `perSide`
 * comes off the catalogue's own `isUnilateral`, which is the one field that would
 * otherwise be re-decided by hand on every single-leg move somebody adds.
 *
 * All of it is editable the moment the row lands. These are a starting point, not a
 * prescription: the app has no idea what this athlete's knee will take.
 */
const defaultsFor = (hit: ExerciseHit): StrengthExercise => {
  const hold = hit.category === 'stretching'
  return {
    exerciseId: hit.id,
    name: hit.name,
    sets: 3,
    reps: hold ? null : 10,
    durationS: hold ? 30 : null,
    perSide: hit.isUnilateral,
    restS: hold ? null : 60,
    load: null,
    note: null,
  }
}

export function ExercisePicker({
  onPick,
  onClose,
}: {
  onPick: (exercise: StrengthExercise) => void
  onClose: () => void
}) {
  const [text, setText] = useState('')
  const [filter, setFilter] = useState<FilterKey | null>(null)
  const [results, setResults] = useState<ExerciseHit[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const query = text.trim()
  // The endpoint's own rule, checked here so a keystroke that cannot be answered is never
  // sent: two letters, or one facet.
  const askable = query.length >= 2 || filter !== null

  /**
   * Debounced, and cancelled on the way out.
   *
   * `stale` is what stops a slow answer to `pla` from landing after a fast answer to
   * `plancha` — the classic search race, and on a phone on mobile data it is not rare.
   */
  useEffect(() => {
    if (!askable) {
      setResults(null)
      setError(null)
      return
    }

    let stale = false
    const timer = setTimeout(() => {
      setBusy(true)
      const facet = FILTERS.find((f) => f.key === filter)?.query
      searchExercises({ ...facet, q: query || undefined, limit: 30 })
        .then((answer) => {
          if (stale) return
          setResults(answer.results)
          setError(null)
        })
        .catch((cause: unknown) => {
          if (stale) return
          setResults(null)
          setError(cause instanceof ApiError ? cause.message : 'No se pudo buscar')
        })
        .finally(() => {
          if (!stale) setBusy(false)
        })
    }, 250)

    return () => {
      stale = true
      clearTimeout(timer)
    }
  }, [query, filter, askable])

  return (
    <Sheet title="Añadir ejercicio" onClose={onClose} footer={<RepdbAttribution className="px-0" />}>
      <TextInput
        type="search"
        value={text}
        placeholder="Busca: plancha, glúteo, sentadilla…"
        aria-label="Buscar ejercicio"
        onChange={(event) => setText(event.target.value)}
      />

      <div className="flex flex-wrap gap-1.5">
        {FILTERS.map((option) => {
          const on = filter === option.key
          return (
            <button
              key={option.key}
              type="button"
              aria-pressed={on}
              onClick={() => setFilter(on ? null : option.key)}
              className={cn(
                'tappable inline-flex min-h-11 items-center rounded-full px-3 text-caption font-medium',
                on ? 'bg-accent text-surface' : 'bg-fill text-label-2',
              )}
            >
              {option.label}
            </button>
          )
        })}
      </div>

      {error ? (
        <p role="alert" className="text-caption leading-relaxed text-red">
          {error}
        </p>
      ) : !askable ? (
        <p className="text-footnote leading-relaxed text-label-3">
          Escribe al menos dos letras o elige un filtro. El catálogo son 571 ejercicios
          ilustrados: se busca, no se hojea.
        </p>
      ) : results === null ? (
        <p className="text-footnote text-label-3">Buscando…</p>
      ) : results.length === 0 ? (
        <p className="text-footnote leading-relaxed text-label-3">
          Ningún ejercicio con eso. Prueba con otra palabra, o quita el filtro.
        </p>
      ) : (
        <ul className={cn('-mx-1 divide-y divide-line', busy && 'opacity-60')}>
          {results.map((hit) => (
            <ResultRow key={hit.id} hit={hit} onPick={() => onPick(defaultsFor(hit))} />
          ))}
        </ul>
      )}
    </Sheet>
  )
}

/**
 * One row: the illustration, the name, what it needs — and a disclosure for the how.
 *
 * Two targets, and the split is deliberate. The row *is* the add, because adding is what
 * the sheet is for and burying it behind a second tap on every move would be nine extra
 * taps per template. The chevron beside it is the other question — "what actually is
 * this" — and it is a 44px box of its own rather than `IconAction`'s pseudo-element hit
 * area, so the two never overlap: they are adjacent controls in one row, and a target that
 * quietly extends 14px under its neighbour is a row that adds the wrong exercise.
 *
 * The prose is fetched on the first expand and kept after that. Most rows are never
 * opened, and a picker that fetched a kilobyte of instructions for thirty results would
 * spend the whole search budget on text nobody asked to read.
 */
function ResultRow({ hit, onPick }: { hit: ExerciseHit; onPick: () => void }) {
  const [open, setOpen] = useState(false)
  const [full, setFull] = useState<CatalogExercise | null>(null)
  const [failed, setFailed] = useState(false)

  const caption = [equipmentLabel(hit.equipment), categoryLabel(hit.category), difficultyLabel(hit.difficulty)]
    .filter(Boolean)
    .join(' · ')

  function toggle() {
    const next = !open
    setOpen(next)
    if (!next || full || failed) return
    getExercise(hit.id)
      .then(setFull)
      .catch(() => setFailed(true))
  }

  return (
    <li>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={onPick}
          className="tappable flex min-h-11 min-w-0 flex-1 items-center gap-2.5 px-1 py-2 text-left"
        >
          <ExerciseThumb exerciseId={hit.id} className="size-11" />
          <span className="min-w-0 flex-1">
            <span className="block text-footnote font-medium text-label">{hit.name}</span>
            <span className="mt-0.5 block text-caption text-label-3">{caption}</span>
          </span>
        </button>
        <button
          type="button"
          onClick={toggle}
          aria-expanded={open}
          aria-label={`Cómo se hace ${hit.name}`}
          className="tappable flex size-11 shrink-0 items-center justify-center text-label-3"
        >
          <Icon
            path={CHEVRON_DOWN}
            className={cn('motion-standard size-4 transition-transform', open && 'rotate-180')}
          />
        </button>
      </div>

      {open ? (
        <div className="fade-up px-1 pb-2.5">
          {failed ? (
            <p className="text-caption leading-relaxed text-label-3">
              No se pudieron cargar las instrucciones.
            </p>
          ) : !full ? (
            <p className="text-caption text-label-3">Cargando…</p>
          ) : (
            <>
              <p className="text-caption leading-relaxed text-label-2">{full.description}</p>
              <ol className="mt-1.5 space-y-1">
                {full.instructions.map((line, i) => (
                  <li key={i} className="flex gap-1.5 text-caption leading-relaxed text-label-3">
                    <span aria-hidden className="shrink-0 tabular-nums text-label-4">
                      {i + 1}
                    </span>
                    <span>{line}</span>
                  </li>
                ))}
              </ol>
            </>
          )}
        </div>
      ) : null}
    </li>
  )
}
