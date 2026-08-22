/**
 * How this app writes numbers. Spain uses the comma as the decimal mark, so `12.4`
 * reaching a screen is a bug in the same way an untranslated label is — `toFixed` speaks
 * en-US and nothing else here does.
 *
 * A helper rather than `toLocaleString` because every number in the app wants the same
 * two things — a fixed number of decimals and no thousands grouping — and the Intl call
 * that spells that out is longer than the arithmetic it wraps.
 *
 * Pure and browser-safe.
 */

/** `12,4` from 12.4. One decimal unless asked otherwise; `0` gives a plain integer. */
export const decimal = (value: number, digits = 1) =>
  value.toFixed(digits).replace('.', ',')
