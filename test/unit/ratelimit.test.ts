import { describe, expect, it } from 'vitest'
import {
  checkBudget,
  nextQuarterHour,
  nextUtcMidnight,
  readSnapshot,
  recordUsage,
  type RateLimitSnapshot,
} from '@/lib/strava/ratelimit'

/** Minimal in-memory stand-in for the KV namespace the budget persists into. */
function fakeKv(initial?: RateLimitSnapshot) {
  const store = new Map<string, string>()
  if (initial) store.set('strava:ratelimit', JSON.stringify(initial))

  return {
    get: async (_key: string, _type?: string) => {
      const raw = store.get('strava:ratelimit')
      return raw ? JSON.parse(raw) : null
    },
    put: async (_key: string, value: string) => {
      store.set('strava:ratelimit', value)
    },
  } as unknown as KVNamespace
}

const AT = Date.UTC(2026, 7, 22, 12, 7, 30) // 12:07:30 UTC

describe('window boundaries', () => {
  it('rolls to the next natural quarter-hour, not a rolling 15 minutes', () => {
    // Strava resets at :00 :15 :30 :45 — a rolling window would give 12:22:30.
    expect(new Date(nextQuarterHour(AT)).toISOString()).toBe('2026-08-22T12:15:00.000Z')
    expect(new Date(nextQuarterHour(Date.UTC(2026, 7, 22, 12, 15, 0))).toISOString()).toBe(
      '2026-08-22T12:30:00.000Z',
    )
  })

  it('rolls to the next UTC midnight', () => {
    expect(new Date(nextUtcMidnight(AT)).toISOString()).toBe('2026-08-23T00:00:00.000Z')
  })
})

describe('checkBudget', () => {
  it('allows requests when well under both limits', async () => {
    const kv = fakeKv({ shortUsage: 5, shortLimit: 100, dailyUsage: 20, dailyLimit: 1000, at: AT })
    const verdict = await checkBudget(kv, AT)
    expect(verdict.allowed).toBe(true)
    // 100 - 10 reserve - 5 used = 85 short; that is the binding constraint here.
    expect(verdict.remaining).toBe(85)
  })

  it('holds back a reserve so a background backfill cannot starve an interactive sync', async () => {
    const kv = fakeKv({ shortUsage: 92, shortLimit: 100, dailyUsage: 100, dailyLimit: 1000, at: AT })
    const verdict = await checkBudget(kv, AT)
    // 8 real requests remain, but the 10-request reserve means we decline.
    expect(verdict.allowed).toBe(false)
    expect(verdict.retryAt).toBe(nextQuarterHour(AT))
  })

  it('waits for midnight when the daily cap is what is exhausted', async () => {
    const kv = fakeKv({ shortUsage: 0, shortLimit: 100, dailyUsage: 990, dailyLimit: 1000, at: AT })
    const verdict = await checkBudget(kv, AT)
    expect(verdict.allowed).toBe(false)
    // Waiting for the next quarter-hour would busy-loop until midnight.
    expect(verdict.retryAt).toBe(nextUtcMidnight(AT))
  })

  it('treats a snapshot from a previous window as spent', async () => {
    const stale = Date.UTC(2026, 7, 22, 11, 59, 0) // previous quarter-hour
    const kv = fakeKv({ shortUsage: 99, shortLimit: 100, dailyUsage: 50, dailyLimit: 1000, at: stale })
    const verdict = await checkBudget(kv, AT)
    // The short counter has reset; only the daily one carries over.
    expect(verdict.allowed).toBe(true)
  })

  it('resets the daily counter across a midnight boundary', async () => {
    const yesterday = Date.UTC(2026, 7, 21, 23, 50, 0)
    const kv = fakeKv({ shortUsage: 0, shortLimit: 100, dailyUsage: 1000, dailyLimit: 1000, at: yesterday })
    expect((await readSnapshot(kv, AT)).dailyUsage).toBe(0)
  })

  it('defaults to a full budget when nothing is stored', async () => {
    expect((await checkBudget(fakeKv(), AT)).allowed).toBe(true)
  })
})

describe('recordUsage', () => {
  it('mirrors Strava read-limit headers rather than counting ourselves', async () => {
    const kv = fakeKv()
    const headers = new Headers({
      'x-readratelimit-limit': '100,1000',
      'x-readratelimit-usage': '17,432',
    })

    await recordUsage(kv, headers, AT)
    const snapshot = await readSnapshot(kv, AT)
    expect(snapshot).toMatchObject({ shortUsage: 17, dailyUsage: 432, shortLimit: 100, dailyLimit: 1000 })
  })

  it('falls back to the overall limit headers when the read-specific ones are absent', async () => {
    const kv = fakeKv()
    await recordUsage(kv, new Headers({ 'x-ratelimit-limit': '600,30000', 'x-ratelimit-usage': '10,20' }), AT)
    expect(await readSnapshot(kv, AT)).toMatchObject({ shortUsage: 10, dailyUsage: 20 })
  })

  it('ignores malformed headers instead of poisoning the budget with NaN', async () => {
    const kv = fakeKv({ shortUsage: 3, shortLimit: 100, dailyUsage: 4, dailyLimit: 1000, at: AT })
    await recordUsage(kv, new Headers({ 'x-readratelimit-limit': 'nonsense', 'x-readratelimit-usage': 'junk' }), AT)
    expect(await readSnapshot(kv, AT)).toMatchObject({ shortUsage: 3, dailyUsage: 4 })
  })
})
