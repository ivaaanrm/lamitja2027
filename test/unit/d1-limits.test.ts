import { describe, expect, it } from 'vitest'
import { getTableColumns } from 'drizzle-orm'
import { activities, laps } from '@/lib/db/schema'

/**
 * D1 rejects any query with more than 100 bound parameters. A batch insert sends
 * rows × columns parameters, so the row count per statement has to be derived from the
 * column count — otherwise adding a column silently pushes the backfill over the limit
 * and every sync fails at once.
 */
const D1_MAX_BOUND_PARAMS = 100

function rowsPerStatement(columnCount: number): number {
  return Math.max(1, Math.floor(D1_MAX_BOUND_PARAMS / columnCount))
}

describe('D1 bound-parameter budget', () => {
  it.each([
    ['activities', activities],
    ['laps', laps],
  ])('keeps a batched %s insert under the limit', (_name, table) => {
    const columns = Object.keys(getTableColumns(table)).length
    const rows = rowsPerStatement(columns)

    expect(rows).toBeGreaterThanOrEqual(1)
    expect(rows * columns).toBeLessThanOrEqual(D1_MAX_BOUND_PARAMS)
  })

  it('would have exceeded the limit at the original fixed chunk size', () => {
    // Regression guard: the first implementation used a flat 20 rows per statement.
    const columns = Object.keys(getTableColumns(activities)).length
    expect(20 * columns).toBeGreaterThan(D1_MAX_BOUND_PARAMS)
  })

  it('shrinks the row count as columns are added', () => {
    expect(rowsPerStatement(10)).toBe(10)
    expect(rowsPerStatement(26)).toBe(3)
    expect(rowsPerStatement(150)).toBe(1) // never zero, even past the limit
  })
})
