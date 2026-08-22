import { useEffect, useState } from 'react'

interface SyncStatus {
  athlete: { id: number; name: string; profileUrl: string | null } | null
  activities: {
    count: number
    latest: { id: number; name: string; startAt: number } | null
  }
  backfill: { complete: boolean; oldestFetchedAt: number | null; lastFullSyncAt: number | null }
  jobs: Record<string, number>
  rateLimit: { shortUsage: string; dailyUsage: string }
}

type State =
  | { kind: 'loading' }
  | { kind: 'disconnected' }
  | { kind: 'connected'; status: SyncStatus }
  | { kind: 'error'; message: string }

const dateFmt = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })

/**
 * Pages are prerendered, so connection state cannot be server-rendered — it is fetched
 * here. While the backfill runs this polls, which is also the honest progress indicator:
 * the count climbs a page at a time as the cron works through history.
 */
export function ConnectionCard() {
  const [state, setState] = useState<State>({ kind: 'loading' })
  const [busy, setBusy] = useState(false)

  async function runSync() {
    setBusy(true)
    try {
      await fetch('/api/sync/run', { method: 'POST' })
      const response = await fetch('/api/sync/status')
      if (response.ok) setState({ kind: 'connected', status: await response.json() })
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => {
    let cancelled = false
    let timer: ReturnType<typeof setTimeout>
    // Back off rather than hammering /api/sync/status every 5s for the whole life of an
    // open tab — a long backfill would otherwise generate thousands of requests.
    let delay = 3000
    const MAX_DELAY = 30_000

    async function poll() {
      try {
        const response = await fetch('/api/sync/status')
        if (cancelled) return

        if (response.status === 401) {
          setState({ kind: 'disconnected' })
          return
        }
        if (!response.ok) {
          setState({ kind: 'error', message: `Status ${response.status}` })
          return
        }

        const status = (await response.json()) as SyncStatus
        if (cancelled) return
        setState({ kind: 'connected', status })

        // Keep polling only while there is work in flight, easing off as it drags on.
        const pending = (status.jobs.pending ?? 0) > 0
        if (pending || !status.backfill.complete) {
          timer = setTimeout(poll, delay)
          delay = Math.min(MAX_DELAY, Math.round(delay * 1.5))
        }
      } catch (error) {
        if (!cancelled) {
          setState({ kind: 'error', message: error instanceof Error ? error.message : 'Failed' })
        }
      }
    }

    void poll()
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [])

  if (state.kind === 'loading') {
    return <Shell><p className="text-sm text-neutral-500">Checking connection…</p></Shell>
  }

  if (state.kind === 'error') {
    return (
      <Shell>
        <p className="text-sm text-red-400">Could not reach the server: {state.message}</p>
      </Shell>
    )
  }

  if (state.kind === 'disconnected') {
    return (
      <Shell>
        <p className="text-sm text-neutral-400">
          Connect Strava to pull in your training history.
        </p>
        <a
          href="/api/auth/strava/login"
          className="mt-4 inline-flex h-11 items-center justify-center rounded-xl bg-[#fc4c02] px-5 text-sm font-semibold text-white active:opacity-80"
        >
          Connect with Strava
        </a>
      </Shell>
    )
  }

  const { status } = state
  const pending = status.jobs.pending ?? 0
  const syncing = pending > 0 || !status.backfill.complete

  return (
    <Shell>
      <div className="flex items-center gap-3">
        {status.athlete?.profileUrl ? (
          <img
            src={status.athlete.profileUrl}
            alt=""
            className="size-10 rounded-full border border-neutral-700"
          />
        ) : null}
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">{status.athlete?.name ?? 'Connected'}</p>
          <p className="text-xs text-neutral-500">Strava connected</p>
        </div>
      </div>

      <dl className="mt-5 grid grid-cols-2 gap-4">
        <div>
          <dt className="text-xs uppercase tracking-widest text-neutral-500">Activities</dt>
          <dd className="mt-1 text-2xl font-semibold tabular-nums">{status.activities.count}</dd>
        </div>
        <div>
          <dt className="text-xs uppercase tracking-widest text-neutral-500">History</dt>
          <dd className="mt-1 text-2xl font-semibold tabular-nums">
            {status.backfill.complete ? 'Complete' : 'Syncing…'}
          </dd>
        </div>
      </dl>

      {status.activities.latest ? (
        <p className="mt-4 truncate text-xs text-neutral-500">
          Latest: {status.activities.latest.name} ·{' '}
          {dateFmt.format(new Date(status.activities.latest.startAt))}
        </p>
      ) : null}

      <button
        type="button"
        onClick={() => void runSync()}
        disabled={busy}
        className="mt-5 inline-flex h-11 w-full items-center justify-center rounded-xl border border-neutral-700 text-sm font-medium active:opacity-80 disabled:opacity-50"
      >
        {busy ? 'Syncing…' : syncing ? 'Resume sync' : 'Sync now'}
      </button>

      <p className="mt-3 text-xs text-neutral-500">
        {pending > 0 ? `${pending} job${pending === 1 ? '' : 's'} queued. ` : ''}
        Strava allows {status.rateLimit.shortUsage} requests per 15 min. A background sync
        also runs every 15 minutes.
      </p>
    </Shell>
  )
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-2xl border border-neutral-800 bg-neutral-900/50 p-6">{children}</div>
  )
}
