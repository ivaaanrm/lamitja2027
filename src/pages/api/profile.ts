import type { APIRoute } from 'astro'
import { env } from 'cloudflare:workers'
import { eq } from 'drizzle-orm'
import { invalid, json, readJson } from '@/lib/api'
import { profileInput } from '@/lib/auth-input'
import type { BlockConfig } from '@/lib/block'
import { createDb } from '@/lib/db/client'
import { type Block, blocks, users } from '@/lib/db/schema'

export const prerender = false

/** The five fields the rest of the app knows as `BlockConfig` — `userId`/`updatedAt` are storage detail. */
const toBlockConfig = (row: Block): BlockConfig => ({
  startsOn: row.startsOn,
  raceOn: row.raceOn,
  goalTimeS: row.goalTimeS,
  raceDistanceM: row.raceDistanceM,
  raceName: row.raceName,
})

/**
 * The athlete's own settings: display name, max HR (the five zones are shares of it), and
 * the block's dates, distance and goal. All three questions have one answer each per
 * athlete, so this is a PATCH against the caller's own rows and nothing else — there is no
 * id in the URL to get wrong.
 *
 * The block write is an upsert, not an update: `/bienvenida` is the first time an athlete
 * has a `blocks` row at all, and this is the endpoint it PATCHes through.
 *
 * Moving a block's dates does not touch `plan_weeks` or `plan_sessions` — a session's week
 * is derived from `scheduledOn` at read time, so a later `startsOn` can shift which week a
 * session reads as without moving the session itself, and a moved `raceOn` can leave
 * sessions scheduled past the new race day. That mismatch is left for the athlete to see
 * and fix in `/plan`, not silently patched here.
 */
export const PATCH: APIRoute = async ({ request, locals }) => {
  const user = locals.user!
  const parsed = profileInput.safeParse(await readJson(request))
  if (!parsed.success) return invalid(parsed.error)

  const db = createDb(env.DB)
  const { displayName, hrMax, block } = parsed.data

  if (displayName !== undefined || hrMax !== undefined) {
    await db
      .update(users)
      .set({
        ...(displayName !== undefined && { displayName }),
        ...(hrMax !== undefined && { hrMax }),
      })
      .where(eq(users.id, user.id))
  }

  if (block) {
    const patch = { ...block, updatedAt: Date.now() }
    await db
      .insert(blocks)
      .values({ userId: user.id, ...patch })
      .onConflictDoUpdate({ target: blocks.userId, set: patch })
  }

  const [updatedUser, blockRow] = await Promise.all([
    db.query.users.findFirst({ where: eq(users.id, user.id) }),
    db.query.blocks.findFirst({ where: eq(blocks.userId, user.id) }),
  ])
  if (!updatedUser) return json({ error: 'No existe ese usuario' }, 404)

  return json({
    user: {
      id: updatedUser.id,
      displayName: updatedUser.displayName,
      email: updatedUser.email,
      isAdmin: updatedUser.isAdmin,
      hrMax: updatedUser.hrMax,
    },
    block: blockRow ? toBlockConfig(blockRow) : null,
  })
}
