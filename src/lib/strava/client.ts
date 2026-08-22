import { StravaApiError, StravaAuthError, StravaRateLimitError } from './errors'
import { checkBudget, nextQuarterHour, recordUsage } from './ratelimit'
import type { StravaActivity, StravaAthlete, StravaLap } from './types'

const API_BASE = 'https://www.strava.com/api/v3'

/** Strava's own maximum page size. Fewer requests per activity fetched. */
export const MAX_PER_PAGE = 200

export interface StravaClientOptions {
  accessToken: string
  /** KV namespace holding the shared read-rate budget. */
  kv: KVNamespace
  now?: () => number
}

export class StravaClient {
  private readonly accessToken: string
  private readonly kv: KVNamespace
  private readonly now: () => number

  constructor({ accessToken, kv, now = Date.now }: StravaClientOptions) {
    this.accessToken = accessToken
    this.kv = kv
    this.now = now
  }

  private async request<T>(path: string, params?: Record<string, string | number>): Promise<T> {
    const at = this.now()

    const budget = await checkBudget(this.kv, at)
    if (!budget.allowed) {
      throw new StravaRateLimitError(
        `Strava read budget exhausted; retry after ${new Date(budget.retryAt).toISOString()}`,
        budget.retryAt,
      )
    }

    const url = new URL(`${API_BASE}${path}`)
    for (const [key, value] of Object.entries(params ?? {})) {
      url.searchParams.set(key, String(value))
    }

    const response = await fetch(url, {
      headers: { authorization: `Bearer ${this.accessToken}` },
    })

    // Record before branching on status — a 429 is exactly when the numbers matter.
    await recordUsage(this.kv, response.headers, at)

    if (response.status === 429) {
      throw new StravaRateLimitError('Strava returned 429', nextQuarterHour(at))
    }
    if (response.status === 401) {
      throw new StravaAuthError('Strava rejected the access token')
    }
    if (!response.ok) {
      const detail = await response.text().catch(() => '')
      throw new StravaApiError(`Strava ${path} returned ${response.status}: ${detail}`, response.status)
    }

    return (await response.json()) as T
  }

  getAthlete(): Promise<StravaAthlete> {
    return this.request<StravaAthlete>('/athlete')
  }

  /**
   * One page of the athlete's activities, newest first.
   *
   * `after` and `before` are epoch **seconds** and are exclusive bounds. Paging with
   * `after` walks forward from the last known activity; paging with `before` walks
   * history backwards, which is how the backfill proceeds.
   */
  getActivities(options: {
    after?: number
    before?: number
    page?: number
    perPage?: number
  } = {}): Promise<StravaActivity[]> {
    const params: Record<string, number> = {
      page: options.page ?? 1,
      per_page: options.perPage ?? MAX_PER_PAGE,
    }
    if (options.after !== undefined) params.after = options.after
    if (options.before !== undefined) params.before = options.before

    return this.request<StravaActivity[]>('/athlete/activities', params)
  }

  getActivity(id: number): Promise<StravaActivity> {
    return this.request<StravaActivity>(`/activities/${id}`, { include_all_efforts: 'false' })
  }

  getActivityLaps(id: number): Promise<StravaLap[]> {
    return this.request<StravaLap[]>(`/activities/${id}/laps`)
  }
}
