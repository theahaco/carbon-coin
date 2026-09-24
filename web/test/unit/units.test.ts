import { afterEach, describe, expect, it } from 'vitest'
import { unitsForCash } from '../../src/lib/dealing'
import {
  LEGACY_LEDGER_SCALE,
  formatAmountExact,
  formatUnits,
  getLedgerScale,
  isWholeThousandths,
  parseUnits,
  rawFromThousandths,
  setLedgerScale,
} from '../../src/lib/units'

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

describe('units scale from deployment.json (AssetScale)', () => {
  afterEach(() => setLedgerScale(undefined))

  it('keeps the legacy 10^9 scale when the config has no assetScale', () => {
    setLedgerScale(undefined)
    expect(getLedgerScale()).toBe(LEGACY_LEDGER_SCALE)
    expect(formatUnits('235187958000000')).toBe('235,187.958')
    expect(parseUnits('1')).toBe('1000000000')
  })

  it('reads units 1:1 with the ledger at AssetScale 3', () => {
    setLedgerScale(3)
    expect(formatUnits('1000000')).toBe('1,000.000')
    expect(formatUnits('986000')).toBe('986.000')
    expect(formatUnits('235187958')).toBe('235,187.958')
    expect(formatAmountExact('1')).toBe('0.001')
    expect(isWholeThousandths('1')).toBe(true)
    expect(parseUnits('25,000.000')).toBe('25000000')
    expect(parseUnits('0.001')).toBe('1')
    expect(() => parseUnits('0.0001')).toThrow(/3 decimals/)
    expect(rawFromThousandths(235_187_958n)).toBe(235_187_958n)
  })

  it('makes the contract note exact at AssetScale 3', () => {
    setLedgerScale(3)
    expect(unitsForCash(2_450_000, 10.4172)).toBe(235_187_958n)
    expect(formatUnits(unitsForCash(2_450_000, 10.4172))).toBe('235,187.958')
  })

  it('shows finer amounts in full at scales above 3, and coarser scales still show 3 decimals', () => {
    setLedgerScale(6)
    expect(formatUnits('1234567')).toBe('1.234')
    expect(formatAmountExact('1234567')).toBe('1.234567')
    setLedgerScale(0)
    expect(formatUnits('25')).toBe('25.000')
    expect(parseUnits('25')).toBe('25')
    expect(() => parseUnits('25.5')).toThrow(/whole units/)
    expect(rawFromThousandths(25_500n)).toBe(25n)
  })

  it('rejects an invalid assetScale instead of guessing', () => {
    expect(() => setLedgerScale(-1)).toThrow(/invalid assetScale/)
    expect(() => setLedgerScale(2.5)).toThrow(/invalid assetScale/)
    expect(() => setLedgerScale(20)).toThrow(/invalid assetScale/)
  })
})

describe('units input bounds', () => {
  it('refuses an amount past the ledger maximum (2^63 - 1 raw)', () => {
    setLedgerScale(3)
    expect(parseUnits('9223372036854775.807')).toBe('9223372036854775807')
    expect(() => parseUnits('9223372036854775.808')).toThrow(/more units than the ledger/)
    setLedgerScale(undefined)
  })
})
