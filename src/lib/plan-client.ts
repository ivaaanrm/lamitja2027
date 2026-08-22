import type { PlanSession, PlanWeek } from './db/schema'
import type { CreateSessionInput, UpdateSessionInput, UpdateWeekInput } from './plan-input'

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
