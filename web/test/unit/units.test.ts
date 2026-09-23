import { describe, expect, it } from 'vitest'
import { formatAmountExact, formatUnits, isWholeThousandths, parseUnits } from '../../src/lib/units'

describe('units display', () => {
  it('shows 3 decimals with en-GB grouping', () => {
    expect(formatUnits('235187958000000')).toBe('235,187.958')
    expect(formatUnits('0')).toBe('0.000')
    expect(formatUnits(12_500_000_000_000n)).toBe('12,500.000')
  })

  it('floors below the third decimal instead of rounding', () => {
    expect(formatUnits('999999999')).toBe('0.999')
    expect(formatUnits('1999999')).toBe('0.001')
    expect(formatUnits('999999')).toBe('0.000')
    expect(formatUnits('235187958999999')).toBe('235,187.958')
  })

  it('floors negative differences towards minus infinity', () => {
    expect(formatUnits(-1n)).toBe('−0.001')
    expect(formatUnits(-2_000_000n)).toBe('−0.002')
  })
})

describe('units input', () => {
  it('accepts grouping and up to 3 decimals at the unchanged 10^9 ledger scale', () => {
    expect(parseUnits('25,000.000')).toBe('25000000000000')
    expect(parseUnits(' 1 000.5 ')).toBe('1000500000000')
    expect(parseUnits('0.001')).toBe('1000000')
  })

  it('rejects more than 3 decimals, zero, negatives and junk', () => {
    expect(() => parseUnits('1.0001')).toThrow(/3 decimals/)
    expect(() => parseUnits('0')).toThrow(/more than zero/)
    expect(() => parseUnits('-5')).toThrow()
    expect(() => parseUnits('abc')).toThrow()
    expect(() => parseUnits('')).toThrow()
  })
})

describe('single-payment amounts', () => {
  it('keep 3 decimals for whole thousandths and show every digit otherwise', () => {
    expect(formatAmountExact('25000000000000')).toBe('25,000.000')
    expect(formatAmountExact('25000000999999')).toBe('25,000.000999999')
    expect(formatAmountExact('1')).toBe('0.000000001')
    expect(formatAmountExact('1500000')).toBe('0.0015')
    expect(isWholeThousandths('235187958000000')).toBe(true)
    expect(isWholeThousandths('235187958999999')).toBe(false)
  })
})
