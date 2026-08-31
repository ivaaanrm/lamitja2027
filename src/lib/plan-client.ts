import type { PlanSession, PlanWeek, WorkoutTemplate } from './db/schema'
import type { CatalogExercise } from './exercises/catalog'
import type {
  CreateSessionInput,
  CreateTemplateInput,
  UpdateSessionInput,
  UpdateTemplateInput,
  UpdateWeekInput,
} from './plan-input'

/**
 * Browser-side calls into the plan API. Thin on purpose: the editor holds no optimistic
 * copy of the plan, it re-reads `/api/data` after every write. The whole block is a few
 * tens of KB, so a round trip is cheaper than a cache that can disagree with the database.
 */

export class ApiError extends Error {
  constructor(
    message: string,
    readonly issues: { path: string; message: string }[] = [],
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

async function send<T>(url: string, method: string, body?: unknown): Promise<T> {
  const response = await fetch(url, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })

  if (response.status === 401) {
    location.href = '/login'
    throw new ApiError('Sesión cerrada')
  }
  if (!response.ok) {
    const detail = (await response.json().catch(() => null)) as {
      error?: string
      issues?: { path: string; message: string }[]
    } | null
    throw new ApiError(detail?.error ?? `Falló la petición (${response.status})`, detail?.issues ?? [])
  }

  return response.status === 204 ? (undefined as T) : ((await response.json()) as T)
}

export const createSession = (input: CreateSessionInput) =>
  send<PlanSession>('/api/plan/sessions', 'POST', input)

export const updateSession = (id: string, patch: UpdateSessionInput) =>
  send<PlanSession>(`/api/plan/sessions/${encodeURIComponent(id)}`, 'PATCH', patch)

export const deleteSession = (id: string) =>
  send<void>(`/api/plan/sessions/${encodeURIComponent(id)}`, 'DELETE')

export const updateWeek = (weekIndex: number, patch: UpdateWeekInput) =>
  send<PlanWeek>(`/api/plan/weeks/${weekIndex}`, 'PATCH', patch)

/** Ticking a session off by hand — the path strength and cross sessions take, since they never reach Strava. */
export const setDone = (id: string, done: boolean) =>
  updateSession(id, { doneAt: done ? Date.now() : null })

export const createTemplate = (input: CreateTemplateInput) =>
  send<WorkoutTemplate>('/api/templates', 'POST', input)

export const updateTemplate = (id: string, patch: UpdateTemplateInput) =>
  send<WorkoutTemplate>(`/api/templates/${encodeURIComponent(id)}`, 'PATCH', patch)

export const deleteTemplate = (id: string) =>
  send<void>(`/api/templates/${encodeURIComponent(id)}`, 'DELETE')

/**
 * The catalogue, read across the wire rather than bundled.
 *
 * `src/lib/exercises/` is ~630 KB of Spanish prose and never leaves the Worker; the picker
 * asks it a question and gets back at most fifty trimmed rows. The `import type` above is
 * erased at build, so naming the catalogue's own record type here costs the bundle nothing
 * and stops these two shapes drifting from the ones the endpoint actually returns.
 */
export type ExerciseHit = Pick<
  CatalogExercise,
  'id' | 'name' | 'category' | 'equipment' | 'bodyPart' | 'difficulty' | 'isUnilateral'
>

export interface ExerciseQuery {
  q?: string
  muscle?: string
  equipment?: string
  tag?: string
  bodyPart?: string
  category?: string
  /** Only moves that need nothing — the catalogue's `equipment === null`. */
  bodyweight?: boolean
  limit?: number
}

/**
 * The endpoint refuses a query with no text and no facet — it is a search box, not a
 * dataset dump — so a picker opening on nothing must not call this until something is
 * typed or a chip is tapped.
 */
export const searchExercises = (query: ExerciseQuery) => {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === '' || value === false) continue
    params.set(key, value === true ? '1' : String(value))
  }
  return send<{ results: ExerciseHit[] }>(`/api/exercises?${params}`, 'GET')
}

/** The full record for one exercise: description, instructions, tips, muscles, poses. */
export const getExercise = (id: string) =>
  send<CatalogExercise>(`/api/exercises/${encodeURIComponent(id)}`, 'GET')
