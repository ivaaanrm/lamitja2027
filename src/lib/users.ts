import { and, eq } from 'drizzle-orm'
import type { SessionUser } from './auth'
import type { Database } from './db/client'
import { type User, users } from './db/schema'
import { hashPassword } from './password'

/**
 * Accounts. Invite-only, so there is no sign-up path that does not come through
 * `invites.ts` — the two public writers are `/api/register` and the one-shot
 * `/api/bootstrap`.
 *
 * Every lookup goes through `normaliseEmail`. A unique index only sees the string it is
 * given, so `Marc@…` registering over `marc@…` would be two accounts for one person.
 */
export const normaliseEmail = (email: string) => email.trim().toLowerCase()

export async function findByEmail(db: Database, email: string): Promise<User | null> {
  const row = await db.query.users.findFirst({ where: eq(users.email, normaliseEmail(email)) })
  return row ?? null
}

export async function findById(db: Database, id: string): Promise<User | null> {
  const row = await db.query.users.findFirst({ where: eq(users.id, id) })
  return row ?? null
}

export async function createUser(
  db: Database,
  input: { email: string; password: string; displayName: string; isAdmin?: boolean },
): Promise<User> {
  const { hash, salt } = await hashPassword(input.password)
  const [row] = await db
    .insert(users)
    .values({
      id: crypto.randomUUID(),
      email: normaliseEmail(input.email),
      passwordHash: hash,
      passwordSalt: salt,
      displayName: input.displayName.trim(),
      isAdmin: input.isAdmin ?? false,
      createdAt: Date.now(),
    })
    .returning()
  return row
}

/**
 * Claims the owner row, whose hash the migration left empty precisely so this can find
 * it. The empty hash is part of the WHERE rather than something read first and checked
 * after: that is what makes a second bootstrap a no-op instead of a password overwrite.
 * Null means the app is already bootstrapped.
 */
export async function bootstrapOwner(
  db: Database,
  input: { email: string; password: string; displayName: string },
): Promise<User | null> {
  const { hash, salt } = await hashPassword(input.password)
  const [row] = await db
    .update(users)
    .set({
      email: normaliseEmail(input.email),
      passwordHash: hash,
      passwordSalt: salt,
      displayName: input.displayName.trim(),
    })
    .where(and(eq(users.passwordHash, ''), eq(users.isAdmin, true)))
    .returning()
  return row ?? null
}

/**
 * The compensating write behind `/api/register`. `invites.usedBy` points at a user, so the
 * account has to exist before its invite can be claimed — and D1 has no interactive
 * transaction to wrap the pair in. An account whose claim lost the race is therefore
 * undone rather than prevented, which is the one ordering that never leaves an account
 * standing on a spent invitation.
 */
export async function deleteUser(db: Database, id: string): Promise<void> {
  await db.delete(users).where(eq(users.id, id))
}

/** What the cookie resolves to and what `/api/data` serialises — never the hash or salt. */
export const toSessionUser = (user: User): SessionUser => ({
  id: user.id,
  isAdmin: user.isAdmin,
  displayName: user.displayName,
  email: user.email,
  hrMax: user.hrMax,
  baselineKey: user.baselineKey,
  hasMcpToken: user.mcpTokenHash !== null,
})

