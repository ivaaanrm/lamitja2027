import { and, desc, eq, exists, gt, isNotNull, isNull, lt, ne, notExists, or, sql } from 'drizzle-orm'
import type { Database } from '../db/client'
import {
  oauthGrants,
  oauthTokens,
  type NewOAuthGrant,
  type NewOAuthToken,
  type OAuthGrant,
  type OAuthToken,
} from '../db/schema'

/**
 * The storage the authorization server needs, as one narrow interface.
 *
 * Narrow so that `server.ts` — where every security decision is made — can be tested in
 * plain Node against an in-memory copy, exactly as `protocol.ts` is tested against a stub
 * registry. The interface is shaped by the two atomic claims rather than by tables: a code
 * is *redeemed* and a refresh token is *retired*, each as a single conditional write that
 * one request wins and any concurrent one loses. Those conditions live in the SQL below,
 * not in a read-then-write in the caller, because a read-then-write is the race.
 *
 * The two `find…` lookups by hash take no user id, and that is the shape of the MCP token
 * lookup too: presenting the credential is how a request *establishes* whose row it is.
 * Every write after that names `userId` alongside the row's own key —
 * `test/unit/oauth.test.ts` reads this file and fails if one does not.
 */

export type Grant = OAuthGrant
export type NewGrant = NewOAuthGrant
export type Token = OAuthToken
export type TokenKind = Token['kind']

/** A token about to be stored: the hash and what it is, nothing about whose — the grant says that. */
export type NewToken = Pick<NewOAuthToken, 'hash' | 'kind' | 'parentHash' | 'expiresAt'>

export interface GrantStore {
  /** A new grant holding an unredeemed code. */
  create(grant: NewGrant): Promise<void>
  /** The grant whose code hashes to this — redeemed or not, so reuse can be detected. */
  findByCode(codeHash: string): Promise<Grant | null>
  /** Marks the code used. `false` if another request got there first. */
  redeem(grant: Grant, now: number): Promise<boolean>
  /**
   * Stores a fresh pair on the grant, marks it used, and drops its tokens past expiry.
   * `false` when the grant no longer exists — revoked between the read and this write.
   */
  issue(grant: Grant, tokens: NewToken[], now: number): Promise<boolean>
  /** A token of this kind and the grant it belongs to. Never a token whose grant is gone. */
  findToken(hash: string, kind: TokenKind): Promise<{ token: Token; grant: Grant } | null>
  /**
   * Retires a live refresh token and its live siblings, keeping them until `keepUntil` so a
   * later presentation can be recognised. `false` when it was already retired — a
   * concurrent refresh claimed it first.
   */
  retire(token: Token, now: number, keepUntil: number): Promise<boolean>
  /**
   * Whether a refresh token issued in exchange for this one has been used. If so, the
   * client already holds and used the successor, and this token showing up again is no
   * retry — whatever the clock says.
   */
  successorUsed(token: Token): Promise<boolean>
  /** Deletes the grant and every token it holds. */
  revoke(userId: string, grantId: string): Promise<void>
  /** This athlete's live connections — redeemed, with a live refresh token — newest first. */
  list(userId: string, now: number): Promise<Grant[]>
  /** Drops this athlete's codes nobody redeemed and connections nobody refreshed in time. */
  prune(userId: string, now: number): Promise<void>
}

/** The D1 implementation — the only one the Worker ever uses. */
export function d1GrantStore(db: Database): GrantStore {
  /** A live refresh token on the grant in the outer query — what keeps a connection alive. */
  const liveRefresh = (now: number) =>
    db
      .select({ one: sql`1` })
      .from(oauthTokens)
      .where(
        and(
          eq(oauthTokens.userId, oauthGrants.userId),
          eq(oauthTokens.grantId, oauthGrants.id),
          eq(oauthTokens.kind, 'refresh'),
          isNull(oauthTokens.retiredAt),
          gt(oauthTokens.expiresAt, now),
        ),
      )

  return {
    async create(grant) {
      await db.insert(oauthGrants).values(grant)
    },

    async findByCode(codeHash) {
      const [grant] = await db.select().from(oauthGrants).where(eq(oauthGrants.codeHash, codeHash)).limit(1)
      return grant ?? null
    },

    async redeem(grant, now) {
      const claimed = await db
        .update(oauthGrants)
        .set({ codeUsedAt: now })
        .where(
          and(
            eq(oauthGrants.userId, grant.userId),
            eq(oauthGrants.id, grant.id),
            isNull(oauthGrants.codeUsedAt),
          ),
        )
        .returning({ id: oauthGrants.id })
      return claimed.length === 1
    },

    async issue(grant, tokens, now) {
      // One batch, so a pair is never half-stored. The prune rides along because this is
      // the one moment a connection is known to be in use — and it is what keeps a table
      // that gains a row per refresh from growing for as long as the connection lives.
      try {
        await db.batch([
          db.insert(oauthTokens).values(tokens.map((token) => ({ ...token, userId: grant.userId, grantId: grant.id }))),
          db
            .update(oauthGrants)
            .set({ lastUsedAt: now })
            .where(and(eq(oauthGrants.userId, grant.userId), eq(oauthGrants.id, grant.id))),
          db
            .delete(oauthTokens)
            .where(
              and(
                eq(oauthTokens.userId, grant.userId),
                eq(oauthTokens.grantId, grant.id),
                lt(oauthTokens.expiresAt, now),
              ),
            ),
        ])
        return true
      } catch (error) {
        // A revoke that landed between the read and this write: the composite foreign key
        // refuses a token for a grant that is gone. That is an answer, not a fault — any
        // other failure, with the grant still there, is one.
        const [still] = await db
          .select({ id: oauthGrants.id })
          .from(oauthGrants)
          .where(and(eq(oauthGrants.userId, grant.userId), eq(oauthGrants.id, grant.id)))
          .limit(1)
        if (still) throw error
        return false
      }
    },

    async findToken(hash, kind) {
      // An inner join, so a token whose grant has been deleted never resolves — even on a
      // database where the foreign key's cascade did not run.
      const [row] = await db
        .select({ token: oauthTokens, grant: oauthGrants })
        .from(oauthTokens)
        .innerJoin(
          oauthGrants,
          and(eq(oauthGrants.userId, oauthTokens.userId), eq(oauthGrants.id, oauthTokens.grantId)),
        )
        .where(and(eq(oauthTokens.hash, hash), eq(oauthTokens.kind, kind)))
        .limit(1)
      return row ?? null
    },

    async retire(token, now, keepUntil) {
      const retired = { retiredAt: now, expiresAt: sql`min(${oauthTokens.expiresAt}, ${keepUntil})` }
      const claimed = await db
        .update(oauthTokens)
        .set(retired)
        .where(
          and(
            eq(oauthTokens.userId, token.userId),
            eq(oauthTokens.hash, token.hash),
            isNull(oauthTokens.retiredAt),
          ),
        )
        .returning({ hash: oauthTokens.hash })
      if (claimed.length !== 1) return false

      // Its siblings: the pair a client was handed and did not keep, from a race or a lost
      // answer. The client has moved on from their parent, so they are nobody's now.
      if (token.parentHash !== null) {
        await db
          .update(oauthTokens)
          .set(retired)
          .where(
            and(
              eq(oauthTokens.userId, token.userId),
              eq(oauthTokens.grantId, token.grantId),
              eq(oauthTokens.kind, 'refresh'),
              eq(oauthTokens.parentHash, token.parentHash),
              ne(oauthTokens.hash, token.hash),
              isNull(oauthTokens.retiredAt),
            ),
          )
      }
      return true
    },

    async successorUsed(token) {
      const [used] = await db
        .select({ one: sql`1` })
        .from(oauthTokens)
        .where(
          and(
            eq(oauthTokens.userId, token.userId),
            eq(oauthTokens.grantId, token.grantId),
            eq(oauthTokens.parentHash, token.hash),
            isNotNull(oauthTokens.retiredAt),
          ),
        )
        .limit(1)
      return used !== undefined
    },

    async revoke(userId, grantId) {
      // Tokens first and explicitly, rather than trusting the cascade alone.
      await db.batch([
        db.delete(oauthTokens).where(and(eq(oauthTokens.userId, userId), eq(oauthTokens.grantId, grantId))),
        db.delete(oauthGrants).where(and(eq(oauthGrants.userId, userId), eq(oauthGrants.id, grantId))),
      ])
    },

    list: (userId, now) =>
      db
        .select()
        .from(oauthGrants)
        .where(and(eq(oauthGrants.userId, userId), isNotNull(oauthGrants.codeUsedAt), exists(liveRefresh(now))))
        .orderBy(desc(oauthGrants.createdAt)),

    async prune(userId, now) {
      await db
        .delete(oauthGrants)
        .where(
          and(
            eq(oauthGrants.userId, userId),
            or(
              and(isNull(oauthGrants.codeUsedAt), lt(oauthGrants.codeExpiresAt, now)),
              and(isNotNull(oauthGrants.codeUsedAt), notExists(liveRefresh(now))),
            ),
          ),
        )
    },
  }
}
