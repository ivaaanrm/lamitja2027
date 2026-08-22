/** Race day, fixed. Local Barcelona morning start, but only the date matters here. */
export const RACE_DATE = new Date('2027-01-24T00:00:00Z')

const MS_PER_DAY = 86_400_000

export interface Countdown {
  daysToGo: number
  weeksToGo: number
}

/**
 * Whole days from `now` to race day, floored at zero so the UI degrades to "0"
 * on and after race day rather than going negative.
 */
export function raceCountdown(now: Date, raceDate: Date = RACE_DATE): Countdown {
  const startOfToday = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  const daysToGo = Math.max(0, Math.round((raceDate.getTime() - startOfToday) / MS_PER_DAY))

  return { daysToGo, weeksToGo: Math.floor(daysToGo / 7) }
}
