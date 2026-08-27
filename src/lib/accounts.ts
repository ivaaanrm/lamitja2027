import { eq } from 'drizzle-orm'
import type { Database } from './db/client'
import { type StravaAccount, type StravaAthlete, stravaAccounts } from './db/schema'

/**
 * The Strava connection, one row per athlete. Replaces `state.ts`: both of app_state's
 * values — the rotating refresh token and the last-sync stamp — were per-athlete facts
 * wearing a global coat, and a key/value row keyed on nothing but a string cannot hold two
 * athletes' credentials.
 *
 * Every function here takes the user it is about. There is no "the account".
 */

/** `null` when this athlete has never connected, or disconnected again. */
export async function getAccount(db: Database, userId: string): Promise<StravaAccount | null> {
  const row = await db.query.stravaAccounts.findFirst({
    where: eq(stravaAccounts.userId, userId),
  })
  return row ?? null
}

/**
 * What the two writers carry. All optional because they carry different things: the
 * connect callback has the athlete and the first token, while a refresh — which happens
 * on every sync, since Strava rotates the token each time — has only the new ciphertext.
 */
export interface AccountPatch {
  athleteId?: number
  athlete?: StravaAthlete
  refreshToken?: string
  lastSyncAt?: number
}

/**
 * Writes whatever the patch carries. A patch with both the athlete id and the token can
 * create the row, so the callback is one upsert; anything less can only be an update, and
 * a token refresh cannot happen without a row to have read the old token from.
 *
 * Reconnecting as a *different* Strava athlete conflicts on `athlete_id`'s unique index
 * rather than on the primary key, which this cannot absorb — the callback checks
 * `findByAthleteId` first and answers 409 instead.
 */
export async function upsertAccount(
  db: Database,
  userId: string,
  patch: AccountPatch,
): Promise<void> {
  const updatedAt = Date.now()
  if (patch.athleteId !== undefined && patch.refreshToken !== undefined) {
    await db
      .insert(stravaAccounts)
      .values({
        userId,
        athleteId: patch.athleteId,
        athlete: patch.athlete,
        refreshToken: patch.refreshToken,
        lastSyncAt: patch.lastSyncAt,
        updatedAt,
      })
      .onConflictDoUpdate({ target: stravaAccounts.userId, set: { ...patch, updatedAt } })
    return
  }
  await db
    .update(stravaAccounts)
    .set({ ...patch, updatedAt })
    .where(eq(stravaAccounts.userId, userId))
}

/**
 * The webhook's only way home: the event body identifies the athlete by `owner_id` and
 * carries nothing else that points at a user. `null` for an athlete we do not hold, which
 * the webhook answers 200 to — Strava must never see an error.
 */
export async function findByAthleteId(
  db: Database,
  athleteId: number,
): Promise<StravaAccount | null> {
  const row = await db.query.stravaAccounts.findFirst({
    where: eq(stravaAccounts.athleteId, athleteId),
  })
  return row ?? null
}

/** Every connected athlete, for the nightly cron. Ordered so its log reads the same way twice. */
export async function listAccounts(db: Database): Promise<StravaAccount[]> {
  return db.query.stravaAccounts.findMany({ orderBy: stravaAccounts.userId })
}

/**
 * `updatedAt` deliberately stays put: it means "when this connection last changed", which
 * is what the settings screen is about, and a nightly sync changes nothing about it.
 */
export async function setLastSync(db: Database, userId: string, at: number): Promise<void> {
  await db
    .update(stravaAccounts)
    .set({ lastSyncAt: at })
    .where(eq(stravaAccounts.userId, userId))
}

/**
 * Disconnect. The activities already synced stay — they are the athlete's training record,
 * not Strava's copy of it — so this only drops the credential.
 */
export async function deleteAccount(db: Database, userId: string): Promise<void> {
  await db.delete(stravaAccounts).where(eq(stravaAccounts.userId, userId))
}
