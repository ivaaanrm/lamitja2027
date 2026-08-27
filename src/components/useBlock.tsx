import { useCallback, useEffect, useMemo, useState } from 'react'
import { startOfDay, totalWeeks, wallClockNow, weekIndex, type BlockConfig } from '@/lib/block'
import { bootDone } from '@/lib/boot'
import type { SessionUser } from '@/lib/auth'
import { blockProgress, type BlockProgress } from '@/lib/metrics'
import { setOffline } from '@/lib/net'
import { buildBlock, type WeekPlan } from '@/lib/plan'
import type { Activity, PlanSession, PlanWeek, StravaAthlete } from '@/lib/db/schema'
import { Card, CardTitle, EmptyState, TextLink } from './ui'

interface BlockData {
  user: SessionUser
  /**
   * `null` for an athlete who registered but has not finished `/bienvenida` yet: there is
   * no `blocks` row to answer with, and every list below is scoped to one, so they come
   * back empty rather than unfiltered. Nothing is synthesised in its place — a made-up
   * start date would put every week index and every metric on a calendar nobody chose.
   */
  block: BlockConfig | null
  /** Whether this athlete has a season to compare against — see `baselineFor`. */
  baseline: boolean
  /** `sessions.length > 0` — whether this athlete has written any plan yet. */
  hasPlan: boolean
  athlete: StravaAthlete | null
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
  /** The signed-in athlete's block — `null` until the first payload lands. */
  block: BlockConfig | null
  user: SessionUser | null
  baseline: boolean
  hasPlan: boolean
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

  // Both are derived off the block, so both stay empty until there is one — every week
  // here is counted from `startsOn`, and there is no honest week 0 without it.
  const weeks = useMemo(
    () =>
      data?.block
        ? buildBlock(data.block, data.weeks, data.sessions, data.activities)
        : ([] as WeekPlan[]),
    [data],
  )
  const progress = useMemo(
    () => (data?.block ? blockProgress(data.block, weeks, now) : null),
    [weeks, data, now],
  )

  return {
    data,
    now,
    error,
    reload,
    weeks,
    progress,
    currentWeek: data?.block
      ? Math.min(totalWeeks(data.block) - 1, Math.max(0, weekIndex(data.block, now)))
      : 0,
    block: data?.block ?? null,
    user: data?.user ?? null,
    baseline: data?.baseline ?? false,
    hasPlan: data?.hasPlan ?? false,
  }
}

/**
 * What every screen behind the dock draws for an athlete whose block is still `null`.
 *
 * The same state `hasPlan: false` describes, one step earlier: a plan needs dates
 * to generate against, so the door here is `/bienvenida` rather than the wizard. One card
 * with one way out, instead of six skeletons that would never fill.
 *
 * It lives beside the hook rather than in `ui/` because it is a reading of this payload,
 * not a shape the design system repeats — same reason `HeaderAvatar` is here.
 */
export function NoBlockCard() {
  return (
    <Card className="fade-up">
      <CardTitle>Tu bloque</CardTitle>
      <EmptyState
        action={
          <TextLink href="/bienvenida" tone="primary">
            Configurar ahora
          </TextLink>
        }
      >
        Todavía no has guardado tu carrera ni tus fechas. Sin ellas no hay semanas que contar.
      </EmptyState>
    </Card>
  )
}

/** `Marc Vidal` → `MV`. Two letters is what fits a 44px circle; one alone reads as a typo. */
function initialsOf(displayName: string): string {
  const words = displayName.trim().split(/\s+/).filter(Boolean)
  const first = words[0]?.[0] ?? ''
  const last = words.length > 1 ? (words.at(-1)?.[0] ?? '') : ''
  return (first + last).toUpperCase()
}

/**
 * The one piece of per-athlete chrome that lives in the header rather than in a tab: the
 * signed-in athlete's own initials, linking to `/ajustes`. Defined beside the hook it
 * reads rather than as a page-level concern, because `App.astro` is prerendered and has no
 * athlete to draw at build time — this mounts as its own tiny island instead, and it reads
 * `useBlock`'s module-scope cache like every screen's own island does, so on every tab but
 * the first it paints instantly rather than opening blank.
 *
 * No skeleton on the empty circle before the first payload lands: it is a corner mark, not
 * a card, and the shimmer this app reserves for content that took a screen's worth of
 * layout to promise would be a bigger claim than a name badge is worth.
 */
export function HeaderAvatar() {
  const { user } = useBlock()

  return (
    <a
      href="/ajustes"
      aria-label="Ajustes"
      className="tappable flex size-11 shrink-0 items-center justify-center rounded-full bg-fill text-caption font-semibold text-label-2"
    >
      {user ? initialsOf(user.displayName) : null}
    </a>
  )
}
