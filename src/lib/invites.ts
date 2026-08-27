import { and, desc, eq, gt, isNull } from 'drizzle-orm'
import { randomToken, sha256Hex } from './crypto'
import type { Database } from './db/client'
import { type Invite, invites } from './db/schema'

/**
 * Invitations. An account exists because an admin minted a single-use link, which is the
 * whole membership model — no open registration, no email verification, no reset flow.
 *
 * Only `sha256Hex(token)` is stored: the link is shown once, at mint time, so a database
 * dump hands over spent fingerprints rather than working invitations. Losing the link
 * means minting another one.
 */
export const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000

export async function createInvite(
  db: Database,
  createdBy: string,
  note: string | null,
  now: number,
): Promise<{ token: string; expiresAt: number }> {
  const token = randomToken(24)
  const expiresAt = now + INVITE_TTL_MS
  await db.insert(invites).values({
    tokenHash: await sha256Hex(token),
    createdBy,
    note,
    expiresAt,
    createdAt: now,
  })
  return { token, expiresAt }
}

/**
 * Consumes an invite, single-use and atomic. The lock is the WHERE clause rather than a
 * read followed by a write: two people opening the same link in the same second both run
 * this UPDATE and SQLite hands exactly one of them a changed row. Expiry rides in the
 * same clause so a stale link cannot be claimed by racing the check either.
 */
export async function claimInvite(
  db: Database,
  token: string,
  userId: string,
  now: number,
): Promise<boolean> {
  const claimed = await db
    .update(invites)
    .set({ usedAt: now, usedBy: userId })
    .where(
      and(
        eq(invites.tokenHash, await sha256Hex(token)),
        isNull(invites.usedAt),
        gt(invites.expiresAt, now),
      ),
    )
    .returning({ tokenHash: invites.tokenHash })
  return claimed.length > 0
}

/**
 * A read-only look before `/api/register` creates anything, so a link that is plainly
 * expired or spent costs no account. `claimInvite` remains the authority — this only
 * spares the common case the create-then-undo dance.
 */
export async function isClaimable(db: Database, token: string, now: number): Promise<boolean> {
  const row = await db.query.invites.findFirst({
    where: and(
      eq(invites.tokenHash, await sha256Hex(token)),
      isNull(invites.usedAt),
      gt(invites.expiresAt, now),
    ),
  })
  return row !== undefined
}

export async function listInvites(db: Database): Promise<Invite[]> {
  return db.query.invites.findMany({ orderBy: [desc(invites.createdAt)] })
}

export const inviteUrl = (origin: string, token: string) => `${origin}/alta?token=${token}`
