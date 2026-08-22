import { useCallback, useEffect, useMemo, useState } from 'react'
import { TOTAL_WEEKS, weekIndex } from '@/lib/block'
import { blockProgress, type BlockProgress } from '@/lib/metrics'
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
  error: string | null
  /** Re-reads `/api/data`. Every mutation ends with this rather than patching local state. */
  reload: () => Promise<void>
  weeks: WeekPlan[]
  progress: BlockProgress | null
  /** Clamped into the block, so the app has a sensible "this week" before it opens. */
  currentWeek: number
}

/**
 * Loads the block once and derives everything else from it. Plan-to-actual matching and
 * all metrics are pure functions over this payload, so they are memoised against the
 * fetched data rather than recomputed per render.
 */
export function useBlock(nowInput?: number): Block {
  // Pinned on mount: a fresh `Date.now()` per render would invalidate every memo below.
  const [mountedAt] = useState(() => Date.now())
  const now = nowInput ?? mountedAt
  const [data, setData] = useState<BlockData | null>(null)
  const [error, setError] = useState<string | null>(null)

  const reload = useCallback(async () => {
    try {
      const response = await fetch('/api/data')
      if (response.status === 401) {
        location.href = '/login'
        return
      }
      if (!response.ok) {
        setError(`Could not load data (${response.status})`)
        return
      }
      setData((await response.json()) as BlockData)
      setError(null)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not reach the server')
    }
  }, [])

  useEffect(() => {
    void reload()
  }, [reload])

  const weeks = useMemo(
    () =>
      data ? buildBlock(TOTAL_WEEKS, data.weeks, data.sessions, data.activities) : ([] as WeekPlan[]),
    [data],
  )
  const progress = useMemo(() => (data ? blockProgress(weeks, now) : null), [weeks, data, now])

  return {
    data,
    error,
    reload,
    weeks,
    progress,
    currentWeek: Math.min(TOTAL_WEEKS - 1, Math.max(0, weekIndex(now))),
  }
}
