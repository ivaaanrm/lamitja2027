import { describe, expect, it } from 'vitest'
import { decimal, decimalInput, parseDecimal } from '@/lib/format'

describe('decimal', () => {
  it('writes the Spanish mark at fixed digits', () => {
    expect(decimal(12.4)).toBe('12,4')
    expect(decimal(30, 0)).toBe('30')
  })
})

describe('decimalInput', () => {
  it('opens a field without padding or float noise', () => {
    expect(decimalInput(30.3)).toBe('30,3')
    expect(decimalInput(30)).toBe('30')
    expect(decimalInput(30.299999)).toBe('30,3')
    expect(decimalInput(8.35)).toBe('8,35')
  })
})

describe('parseDecimal', () => {
  it('reads both decimal marks', () => {
    expect(parseDecimal('30,5')).toBe(30.5)
    expect(parseDecimal('30.5')).toBe(30.5)
    expect(parseDecimal(' 42 ')).toBe(42)
  })

  it('is null for blank and for what is not a number', () => {
    expect(parseDecimal('')).toBeNull()
    expect(parseDecimal('   ')).toBeNull()
    expect(parseDecimal('abc')).toBeNull()
    expect(parseDecimal('1,2,3')).toBeNull()
  })

  it('round-trips what decimalInput writes', () => {
    for (const n of [0.5, 8.35, 21.1, 30, 42.195]) expect(parseDecimal(decimalInput(n, 3))).toBe(n)
  })
})
