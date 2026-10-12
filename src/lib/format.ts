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

/**
 * A number as an editable field holds it: Spanish mark, no padding — `30,3`, `30`, `8,35`.
 * `decimal()` is for reading and pins the digits; a field that opened on `30,0` would make
 * the athlete delete a zero they never typed. Rounded to `digits` first, so a target stored
 * as 30299.999 m does not open as `30,299999`.
 */
export const decimalInput = (value: number, digits = 2) =>
  String(Number(value.toFixed(digits))).replace('.', ',')

/**
 * What a decimal field typed, as a number — or `null` for blank and for anything that is
 * not one.
 *
 * Both marks, because both arrive: the decimal keypad on a Spanish iPhone has a comma on
 * it, a desk keyboard has a point, and `Number('30,5')` is `NaN` — which every caller used
 * to read as "cleared" and saved, so the comma the app itself prints was the one input that
 * silently erased the field.
 */
export function parseDecimal(value: string): number | null {
  const trimmed = value.trim()
  if (trimmed === '') return null
  const parsed = Number(trimmed.replace(',', '.'))
  return Number.isFinite(parsed) ? parsed : null
}
