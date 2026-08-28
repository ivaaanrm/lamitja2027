import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { startOfDay, totalWeeks, wallClockNow, weekIndex, type BlockConfig } from '@/lib/block'
import { bootDone } from '@/lib/boot'
import type { ClientUser } from '@/lib/auth'
import { blockProgress, type BlockProgress } from '@/lib/metrics'
import { setOffline } from '@/lib/net'
import { cn } from '@/lib/cn'
import { buildBlock, type WeekPlan } from '@/lib/plan'
import type { Activity, PlanSession, PlanWeek, StravaAthlete } from '@/lib/db/schema'
import { Card, CardTitle, EmptyState, TextLink } from './ui'

interface BlockData {
  user: ClientUser
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
  user: ClientUser | null
  baseline: boolean
  hasPlan: boolean
}

/**
 * The block, held for the life of the *document* rather than of a component, in a store
 * with subscribers rather than in each island's own state.
 *
 * Tabs navigate in place (see `Base.astro`), so every island mounts fresh while the
 * document survives. Keeping the last payload here is what lets the next tab paint with
 * data on its first render instead of opening blank and popping in a moment later — but
 * *how* it is kept turned out to matter as much as that it is, and the two reasons are
 * worth writing down because both were bugs.
 *
 * **A store, because a page carries two islands.** The screen and the header's avatar are
 * separate React roots, so a payload read into `useState` was two copies of one block: two
 * `/api/data` requests racing on every cold start, and two answers to "who is signed in"
 * after a rename. One store, two subscribers, one request.
 *
 * **`useSyncExternalStore`, because reading it during hydration is otherwise a lie.** The
 * prerendered shell ships the *skeleton* — it was built with no athlete — and an island
 * whose first client render read this cache produced the *block* instead. That is a
 * hydration mismatch, and a hydration mismatch is not a warning: React throws the server
 * markup away and re-renders the entire screen from scratch on the client. On every tab
 * tap after the first, that full re-render landed in the middle of the 220ms transition,
 * which is exactly where a stutter is most visible. `getServerSnapshot` returns the empty
 * snapshot, so hydration matches the HTML it is hydrating; the real one is adopted in the
 * layout effect `useSyncExternalStore` runs straight afterwards, before the frame paints.
 */
interface Snapshot {
  data: BlockData | null
  /** Kept beside the data: a block in hand *and* a failed refresh is a real state. */
  error: string | null
}

const EMPTY: Snapshot = { data: null, error: null }

let snapshot: Snapshot = EMPTY
/** When that payload landed, so a tab tap does not re-ask for something seconds old. */
let fetchedAt = 0
/** The read in flight, so two islands mounting together make one request rather than two. */
let inFlight: Promise<void> | null = null
const listeners = new Set<() => void>()

function publish(next: Snapshot): void {
  snapshot = next
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Must return the same object until something actually changes, or React re-renders forever. */
const readSnapshot = () => snapshot
/** What the prerendered HTML says, which is the only honest answer during hydration. */
const readServerSnapshot = () => EMPTY

/**
 * How long a payload is treated as current. Long enough that walking the four tabs is one
 * request rather than four, short enough that bringing the app back to the foreground
 * after a run shows the run.
 */
const FRESH_FOR_MS = 30_000

/** Re-reads `/api/data`. Every mutation ends here rather than patching local state. */
async function fetchBlock(): Promise<void> {
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
      publish({ ...snapshot, error: `No se pudieron cargar los datos (${response.status})` })
    } else {
      fetchedAt = Date.now()
      publish({ data: (await response.json()) as BlockData, error: null })
      /**
       * The service worker answers from its own copy when the network is gone, and says so
       * with this header. A payload without it proves the connection whatever
       * `navigator.onLine` claims — which is the case a captive portal gets wrong.
       */
      setOffline(response.headers.get('x-lm-stale') === '1')
    }
  } catch (cause) {
    // `fetch` only rejects on a transport failure, so this is "no hay red" and nothing
    // else — including on a device with no worker installed yet.
    setOffline(true)
    publish({
      ...snapshot,
      error: cause instanceof Error ? cause.message : 'No se pudo contactar con el servidor',
    })
  }
  // Outside the `catch`, so both a payload and a failure end the launch screen — an
  // error card with a retry on it is a screen to act on, not one to keep hiding behind
  // a mark. Idempotent, so the reload every mutation ends with costs nothing.
  bootDone()
}

/**
 * The first read of a document, and the one after a resume.
 *
 * Skipped when the payload in hand is seconds old — that is the one the tab behind this
 * one just fetched, and re-asking for it would spend a round trip to repaint identical
 * pixels. Deduped when it is not, because both islands on a page run this on mount.
 */
function ensureBlock(): void {
  if (snapshot.data && Date.now() - fetchedAt < FRESH_FOR_MS) {
    bootDone()
    return
  }
  inFlight ??= fetchBlock().finally(() => {
    inFlight = null
  })
}

interface BlockSource {
  data: BlockData | null
  error: string | null
  /** Re-reads `/api/data`. Always a real read: a mutation's point is that this is stale. */
  reload: () => Promise<void>
}

/**
 * The payload half of `useBlock`, on its own so the header's avatar can have it without
 * the plan.
 *
 * Deriving is what costs: `buildBlock` walks every session in the block against every
 * activity in it, and `HeaderAvatar` draws two letters. It used to call `useBlock` and pay
 * for the whole thing — twice per page, since the screen's own island does it too, on the
 * frame a tab transition is running.
 */
function useBlockSource(): BlockSource {
  const { data, error } = useSyncExternalStore(subscribe, readSnapshot, readServerSnapshot)
  const reload = useCallback(() => fetchBlock(), [])

  useEffect(() => {
    ensureBlock()
  }, [])

  /**
   * Half of what a home-screen app needs and a web page does not: an app is *resumed*, not
   * reopened. The document left open on Tuesday evening is the same document that comes
   * back on Wednesday morning — nothing remounts and no navigation happens — so the
   * payload is re-read on the way back in, but only when the one in hand has gone stale.
   * `online` is the other half of the same story: walking back into signal is the moment a
   * phone that has been showing a cached block can stop.
   */
  useEffect(() => {
    const resume = () => {
      if (document.visibilityState !== 'visible') return
      ensureBlock()
    }

    document.addEventListener('visibilitychange', resume)
    addEventListener('online', resume)
    return () => {
      document.removeEventListener('visibilitychange', resume)
      removeEventListener('online', resume)
    }
  }, [])

  return { data, error, reload }
}

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
  const { data, error, reload } = useBlockSource()

  useEffect(() => {
    const resume = () => {
      if (document.visibilityState !== 'visible') return
      setPinnedNow((previous) => {
        const current = wallClockNow()
        return startOfDay(current) === startOfDay(previous) ? previous : current
      })
    }

    document.addEventListener('visibilitychange', resume)
    return () => document.removeEventListener('visibilitychange', resume)
  }, [])

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
 *
 * It subscribes to the payload without deriving anything from it — `useBlockSource`, not
 * `useBlock`. Two letters do not need the plan matched against the log, and this island
 * renders on three of the four tabs.
 */
export function HeaderAvatar() {
  const { data } = useBlockSource()

  return (
    <HeaderAvatarLink
      displayName={data?.user.displayName ?? null}
      avatarUrl={data?.user.avatarUrl ?? null}
    />
  )
}

/** Initials are painted first and stay underneath the photo as its zero-layout-shift fallback. */
export function AvatarFace({
  displayName,
  avatarUrl,
  className,
}: {
  displayName: string | null
  avatarUrl: string | null
  className?: string
}) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null)
  const showPhoto = avatarUrl !== null && failedUrl !== avatarUrl

  return (
    <span
      className={cn(
        'relative flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-fill text-caption font-semibold text-label-2',
        className,
      )}
    >
      <span aria-hidden>{displayName ? initialsOf(displayName) : null}</span>
      {showPhoto ? (
        <img
          src={avatarUrl}
          alt=""
          width={512}
          height={512}
          decoding="async"
          className="absolute inset-0 size-full object-cover"
          onError={() => setFailedUrl(avatarUrl)}
        />
      ) : null}
    </span>
  )
}

/** The avatar face when a parent island already has the athlete and needs no second hook. */
export function HeaderAvatarLink({
  displayName,
  avatarUrl,
}: {
  displayName: string | null
  avatarUrl: string | null
}) {
  return (
    <a
      href="/ajustes"
      aria-label="Ajustes"
      className="tappable shrink-0 rounded-full"
    >
      <AvatarFace displayName={displayName} avatarUrl={avatarUrl} className="size-11" />
    </a>
  )
}
