/**
 * Strava read-rate budget.
 *
 * The documented limits are **100 requests / 15 min** and **1000 / day**, and the
 * 15-minute window resets on natural quarter-hours (:00 :15 :30 :45), not on a
 * rolling basis. Strava reports authoritative usage on every response via
 * `X-ReadRateLimit-Limit: 100,1000` and `X-ReadRateLimit-Usage: 3,50`, so we mirror
 * those numbers into KV rather than counting ourselves — our own count drifts as soon
 * as a request fails midway or another client uses the same token.
 *
 * The budget is what makes the initial backfill safe: it walks history a page per cron
 * tick instead of looping until Strava starts returning 429s.
 */
const KEY = 'strava:ratelimit'

/** Leave headroom so an interactive sync is never starved by a background backfill. */
const RESERVE_SHORT = 10
const RESERVE_DAILY = 50

export interface RateLimitSnapshot {
  shortUsage: number
  shortLimit: number
  dailyUsage: number
  dailyLimit: number
  /** Epoch ms this snapshot was taken. */
  at: number
}

const DEFAULT_SNAPSHOT: RateLimitSnapshot = {
  shortUsage: 0,
  shortLimit: 100,
  dailyUsage: 0,
  dailyLimit: 1000,
  at: 0,
}

/** Start of the next natural quarter-hour, in epoch ms. */
export function nextQuarterHour(now: number): number {
  const quarter = 15 * 60 * 1000
  return Math.floor(now / quarter) * quarter + quarter
}

/** Next UTC midnight, in epoch ms. */
export function nextUtcMidnight(now: number): number {
  const date = new Date(now)
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1)
}

export async function readSnapshot(kv: KVNamespace, now: number): Promise<RateLimitSnapshot> {
  const stored = await kv.get<RateLimitSnapshot>(KEY, 'json')
  if (!stored) return { ...DEFAULT_SNAPSHOT, at: now }

  // Usage counters reset with their windows; a snapshot from a previous window is stale.
  const snapshot = { ...stored }
  if (nextQuarterHour(stored.at) <= now) snapshot.shortUsage = 0
  if (nextUtcMidnight(stored.at) <= now) snapshot.dailyUsage = 0
  return snapshot
}

export interface BudgetVerdict {
  allowed: boolean
  /** How many more calls we are willing to make in this window. */
  remaining: number
  /** Epoch ms to retry at, when not allowed. */
  retryAt: number
}

export async function checkBudget(
  kv: KVNamespace,
  now: number,
  cost = 1,
): Promise<BudgetVerdict> {
  const s = await readSnapshot(kv, now)

  const shortLeft = s.shortLimit - RESERVE_SHORT - s.shortUsage
  const dailyLeft = s.dailyLimit - RESERVE_DAILY - s.dailyUsage
  const remaining = Math.max(0, Math.min(shortLeft, dailyLeft))

  if (cost <= shortLeft && cost <= dailyLeft) {
    return { allowed: true, remaining, retryAt: now }
  }

  // Blocked by the daily cap means waiting for midnight; the short cap clears sooner.
  const retryAt = dailyLeft < cost ? nextUtcMidnight(now) : nextQuarterHour(now)
  return { allowed: false, remaining, retryAt }
}

/** Mirrors Strava's own accounting from response headers into KV. */
export async function recordUsage(
  kv: KVNamespace,
  headers: Headers,
  now: number,
): Promise<void> {
  const limit = headers.get('x-readratelimit-limit') ?? headers.get('x-ratelimit-limit')
  const usage = headers.get('x-readratelimit-usage') ?? headers.get('x-ratelimit-usage')
  if (!limit || !usage) return

  const [shortLimit, dailyLimit] = limit.split(',').map((n) => Number.parseInt(n, 10))
  const [shortUsage, dailyUsage] = usage.split(',').map((n) => Number.parseInt(n, 10))
  if ([shortLimit, dailyLimit, shortUsage, dailyUsage].some(Number.isNaN)) return

  const snapshot: RateLimitSnapshot = {
    shortLimit,
    dailyLimit,
    shortUsage,
    dailyUsage,
    at: now,
  }

  // Expire a little past midnight so a stale snapshot can never pin the daily counter.
  const ttlSeconds = Math.ceil((nextUtcMidnight(now) - now) / 1000) + 60
  await kv.put(KEY, JSON.stringify(snapshot), { expirationTtl: Math.max(60, ttlSeconds) })
}
