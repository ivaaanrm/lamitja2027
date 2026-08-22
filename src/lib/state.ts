import { eq } from 'drizzle-orm'
import type { Database } from './db/client'
import { appState } from './db/schema'

/** Keys held in the single-row key/value table. */
export const KEY = {
  /** AES-GCM ciphertext. Strava rotates this on every refresh, so it must be persisted. */
  STRAVA_REFRESH_TOKEN: 'strava.refresh_token',
  STRAVA_ATHLETE: 'strava.athlete',
  LAST_SYNC_AT: 'sync.last_at',
} as const

export async function getState(db: Database, key: string): Promise<string | null> {
  const row = await db.query.appState.findFirst({ where: eq(appState.key, key) })
  return row?.value ?? null
}

export async function setState(db: Database, key: string, value: string): Promise<void> {
  const row = { key, value, updatedAt: Date.now() }
  await db.insert(appState).values(row).onConflictDoUpdate({ target: appState.key, set: row })
}
