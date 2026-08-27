import { useCallback, useEffect, useMemo, useState } from 'react'
import { TOTAL_WEEKS, startOfDay, wallClockNow, weekIndex } from '@/lib/block'
import { bootDone } from '@/lib/boot'
import { blockProgress, type BlockProgress } from '@/lib/metrics'
import { setOffline } from '@/lib/net'
import { buildBlock, type WeekPlan } from '@/lib/plan'
import type { Activity, PlanSession, PlanWeek } from '@/lib/db/schema'

interface BlockData {
  athlete: { firstname: string | null; lastname: string | null; profile: string | null } | null
  stravaConnected: boolean
  lastSyncAt: number | null
  activities: Activity[]
  weeks: PlanWeek[]
  sessions: PlanSession[]
}

export interface Block {
  data: BlockData | null
  /** The clock, pinned on mount — every derived window is measured from this one value. */
  now: number
  error: string | null
  /** Re-reads `/api/data`. Every mutation ends with this rather than patching local state. */
  reload: () => Promise<void>
  weeks: WeekPlan[]
  progress: BlockProgress | null
  /** Clamped into the block, so the app has a sensible "this week" before it opens. */
  currentWeek: number
}

/**
 * The last payload `/api/data` returned, kept for the life of the page. Tabs navigate in
 * place (see Base.astro), so each island mounts fresh while the document survives — with
 * this, the next tab paints with data on its first render and revalidates behind it,
 * instead of opening blank and popping in a moment later.
 */
let cached: BlockData | null = null
/** When that payload landed, so a tab tap does not re-ask for something seconds old. */
let cachedAt = 0

/**
 * How long a payload is treated as current. Long enough that walking the four tabs is one
 * request rather than four, short enough that bringing the app back to the foreground
 * after a run shows the run.
 */
const FRESH_FOR_MS = 30_000

/**
 * Loads the block once and derives everything else from it. Plan-to-actual matching and
 * all metrics are pure functions over this payload, so they are memoised against the
 * fetched data rather than recomputed per render.
 */
export function useBlock(nowInput?: number): Block {
  /**
   * Pinned on mount: a fresh reading per render would invalidate every memo below.
   *
   * It is the *wall clock* rather than the raw instant, because everything it is about to
   * be compared against is stored on that scale — see `wallClockNow`. And it is state
   * rather than a constant because an installed PWA is not reopened, it is *resumed*: iOS
   * freezes the document and hands the same one back days later, so a value pinned at
   * mount is a "today" that quietly stops being today. The effect below re-pins it when
   * the date underneath it has actually changed, and only then, so an ordinary
   * foreground costs no recomputation at all.
   */
  const [pinnedNow, setPinnedNow] = useState(() => wallClockNow())
  const now = nowInput ?? pinnedNow
  const [data, setData] = useState<BlockData | null>(cached)
  const [error, setError] = useState<string | null>(null)

  const reload = useCallback(async () => {
    try {
      const response = await fetch('/api/data')
      if (response.status === 401) {
        // The one path that does *not* end the launch screen: the document is already on
        // its way to `/login`, and dropping the overlay first would flash a screenful of
        // skeletons on the way out.
        location.href = '/login'
        return
      }
      if (!response.ok) {
        setError(`No se pudieron cargar los datos (${response.status})`)
        return
      }
      cached = (await response.json()) as BlockData
      cachedAt = Date.now()
      setData(cached)
      setError(null)
      /**
       * The service worker answers from its own copy when the network is gone, and says so
       * with this header. A payload without it proves the connection whatever
       * `navigator.onLine` claims — which is the case a captive portal gets wrong.
       */
      setOffline(response.headers.get('x-lm-stale') === '1')
    } catch (cause) {
      // `fetch` only rejects on a transport failure, so this is "no hay red" and nothing
      // else — including on a device with no worker installed yet.
      setOffline(true)
      setError(cause instanceof Error ? cause.message : 'No se pudo contactar con el servidor')
    }
    // Outside the `catch`, so both a payload and a failure end the launch screen — an
    // error card with a retry on it is a screen to act on, not one to keep hiding behind
    // a mark. Idempotent, so the reload every mutation ends with costs nothing.
    bootDone()
  }, [])

  useEffect(() => {
    // A payload seconds old is the one the tab behind this one just fetched; re-asking for
    // it would spend a round trip to repaint identical pixels.
    if (cached && Date.now() - cachedAt < FRESH_FOR_MS) {
      bootDone()
      return
    }
    void reload()
  }, [reload])

  /**
   * What a home-screen app needs and a web page does not: an app is *resumed*, not
   * reopened. The document that was left open on Tuesday evening is the same document
   * that comes back on Wednesday morning — nothing remounts, no navigation happens, and
   * without this the screen that says "Hoy" would still be showing Tuesday, against a
   * block that has not been re-read since.
   *
   * So both are refreshed on the way back in: the clock, but only when the date under it
   * has actually turned (otherwise every glance at the phone would invalidate every memo
   * on the screen), and the payload, but only when the one in hand has gone stale.
   * `online` is in here for the other half of the same story — walking back into signal is
   * the moment a phone that has been showing a cached block can stop.
   */
  useEffect(() => {
    const resume = () => {
      if (document.visibilityState !== 'visible') return
      setPinnedNow((previous) => {
        const current = wallClockNow()
        return startOfDay(current) === startOfDay(previous) ? previous : current
      })
      if (Date.now() - cachedAt < FRESH_FOR_MS) return
      void reload()
    }

    document.addEventListener('visibilitychange', resume)
    addEventListener('online', resume)
    return () => {
      document.removeEventListener('visibilitychange', resume)
      removeEventListener('online', resume)
    }
  }, [reload])

  const weeks = useMemo(
    () =>
      data ? buildBlock(TOTAL_WEEKS, data.weeks, data.sessions, data.activities) : ([] as WeekPlan[]),
    [data],
  )
  const progress = useMemo(() => (data ? blockProgress(weeks, now) : null), [weeks, data, now])

  return {
    data,
    now,
    error,
    reload,
    weeks,
    progress,
    currentWeek: Math.min(TOTAL_WEEKS - 1, Math.max(0, weekIndex(now))),
  }
}
