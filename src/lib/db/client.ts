import { drizzle } from 'drizzle-orm/d1'
import * as schema from './schema'

export type Database = ReturnType<typeof createDb>

/** Wraps the D1 binding in Drizzle. Cheap — construct per request, do not cache across them. */
export function createDb(d1: D1Database) {
  return drizzle(d1, { schema, casing: 'snake_case', logger: false })
}

export { schema }
