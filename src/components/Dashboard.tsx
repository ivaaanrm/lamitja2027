import { useEffect, useState } from 'react'
import { formatPace, isRun, paceSKm } from '@/lib/activity'
import { BLOCK_START, TOTAL_WEEKS, WEEK_MS, daysToRace, startOfWeek, weekIndex } from '@/lib/block'

interface Activity {
  id: number
  name: string
  sportType: string
  startedOn: number
  distanceM: number
  movingS: number
  averageHeartrate: number | null
  cadenceSpm: number | null
}

interface Data {
  athlete: { firstname: string | null; lastname: string | null; profile: string | null } | null
  stravaConnected: boolean
  lastSyncAt: number | null
  activities: Activity[]
}

const dayFmt = new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })

export function Dashboard() {
  const [data, setData] = useState<Data | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function load() {
    const response = await fetch('/api/data')
    if (response.status === 401) {
      location.href = '/login'
      return
    }
    if (!response.ok) {
      setError(`Could not load data (${response.status})`)
      return
    }
    setData(await response.json())
  }

  async function sync() {
    setBusy(true)
    setError(null)
    try {
      const response = await fetch('/api/sync', { method: 'POST' })
      if (!response.ok) setError(((await response.json()) as { error?: string }).error ?? 'Sync failed')
      await load()
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => {
    void load()
  }, [])

  if (error && !data) return <Card><p className="text-sm text-red-400">{error}</p></Card>
  if (!data) return <Card><p className="text-sm text-neutral-500">Loading…</p></Card>

  if (!data.stravaConnected) {
    return (
      <Card>
        <p className="text-sm text-neutral-400">Connect Strava to pull in this block's runs.</p>
        <a
          href="/api/strava/connect"
          className="mt-4 inline-flex h-11 items-center justify-center rounded-xl bg-[#fc4c02] px-5 text-sm font-semibold text-white active:opacity-80"
        >
          Connect with Strava
        </a>
      </Card>
    )
  }

  const now = Date.now()
  const currentWeek = Math.max(0, weekIndex(now))
  const weekStart = startOfWeek(now)

  const runs = data.activities.filter((a) => isRun(a.sportType))
  const thisWeek = runs.filter((a) => a.startedOn >= weekStart && a.startedOn < weekStart + WEEK_MS)
  const weekKm = thisWeek.reduce((sum, a) => sum + a.distanceM, 0) / 1000
  const blockKm = runs.reduce((sum, a) => sum + a.distanceM, 0) / 1000

  return (
    <>
      <Card>
        <div className="flex items-baseline justify-between">
          <p className="text-xs uppercase tracking-widest text-neutral-500">
            Week {currentWeek + 1} of {TOTAL_WEEKS}
          </p>
          <p className="text-xs text-neutral-500">{daysToRace(now)} days to go</p>
        </div>
        <p className="mt-2 text-4xl font-semibold tabular-nums">
          {weekKm.toFixed(1)}
          <span className="ml-1 text-lg font-normal text-neutral-500">km this week</span>
        </p>
        <p className="mt-1 text-xs text-neutral-500">
          {blockKm.toFixed(0)} km across the block · {runs.length} runs
        </p>
      </Card>

      <Card>
        <div className="flex items-center justify-between">
          <p className="text-xs uppercase tracking-widest text-neutral-500">Recent runs</p>
          <button
            type="button"
            onClick={() => void sync()}
            disabled={busy}
            className="text-xs text-neutral-400 underline underline-offset-4 disabled:opacity-50"
          >
            {busy ? 'Syncing…' : 'Sync'}
          </button>
        </div>

        {runs.length === 0 ? (
          <p className="mt-4 text-sm text-neutral-500">
            No runs yet in this block. It starts {dayFmt.format(new Date(BLOCK_START))}.
          </p>
        ) : (
          <ul className="mt-4 divide-y divide-neutral-800">
            {runs
              .slice()
              .sort((a, b) => b.startedOn - a.startedOn)
              .slice(0, 10)
              .map((run) => (
                <li key={run.id} className="flex items-baseline justify-between gap-3 py-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm">{run.name}</p>
                    <p className="text-xs text-neutral-500">
                      {dayFmt.format(new Date(run.startedOn))}
                      {run.cadenceSpm ? ` · ${run.cadenceSpm} spm` : ''}
                      {run.averageHeartrate ? ` · ${Math.round(run.averageHeartrate)} bpm` : ''}
                    </p>
                  </div>
                  <div className="shrink-0 text-right">
                    <p className="text-sm tabular-nums">{(run.distanceM / 1000).toFixed(2)} km</p>
                    <p className="text-xs tabular-nums text-neutral-500">
                      {formatPace(paceSKm(run.distanceM, run.movingS))}/km
                    </p>
                  </div>
                </li>
              ))}
          </ul>
        )}

        {error ? <p className="mt-3 text-xs text-red-400">{error}</p> : null}
      </Card>
    </>
  )
}

function Card({ children }: { children: React.ReactNode }) {
  return <div className="rounded-2xl border border-neutral-800 bg-neutral-900/50 p-6">{children}</div>
}
