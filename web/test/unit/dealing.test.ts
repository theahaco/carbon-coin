import { describe, expect, it } from 'vitest'
import {
  contractNote,
  formatEuro,
  illustrativeDealing,
  noteShortForm,
  parseDealingMonth,
  sameDealingDay,
  suggestNextDealingDay,
  unitsForCash,
} from '../../src/lib/dealing'
import { suggestNextMintPeriod } from '../../src/lib/xrplClient'
import { alreadyIssued } from '../../src/lib/procedure'
import { formatUnits } from '../../src/lib/units'
import { brand } from '../../src/brand'

const SEPT_2026 = new Date(2026, 8, 23)

describe('contract note', () => {
  it('computes units = cash / NAV, floored to 3 dp', () => {
    // 2,450,000 / 10.4172 = 235,187.9583...
    expect(formatUnits(unitsForCash(2_450_000, 10.4172))).toBe('235,187.958')
    // 1,650,000 / 10.3611 = 159,249.5005...
    expect(formatUnits(unitsForCash(1_650_000, 10.3611))).toBe('159,249.500')
  })

  it('floors an exact boundary without floating-point drift', () => {
    // 1,000 / 3 = 333.3333...: never 333.334
    expect(formatUnits(unitsForCash(1_000, 3))).toBe('333.333')
    // 10.4172 * 1,000 = 10,417.2 exactly: 1,000 units, not 999.999
    expect(formatUnits(unitsForCash(10_417.2, 10.4172))).toBe('1,000.000')
  })

  it('reads the dealing day figures from brand config, with a fallback', () => {
    const note = contractNote('2026-10')
    expect(note).toMatchObject({ day: '2026-10', cash: 2_450_000, nav: 10.4172 })
    expect(formatUnits(note.unitsRaw)).toBe('235,187.958')
    expect(illustrativeDealing('2031-01')).toEqual(brand.dealing.fallback)
  })

  it('formats euros for the note and the short form', () => {
    expect(formatEuro(2_450_000, 2)).toBe('€2,450,000.00')
    expect(formatEuro(10.4172, 4)).toBe('€10.4172')
    expect(noteShortForm({ cash: 2_450_000, nav: 10.4172 })).toBe('€2,450,000 ÷ NAV €10.4172')
  })

  it('rejects a zero NAV', () => {
    expect(() => unitsForCash(1, 0)).toThrow()
  })
})

describe('next dealing day', () => {
  it('suggests the month after the latest dealing day on record', () => {
    expect(suggestNextDealingDay(['2026-07', '2026-09', '2026-08'], SEPT_2026)).toBe('2026-10')
    expect(suggestNextDealingDay(['2026-12'], SEPT_2026)).toBe('2027-01')
  })

  it('never suggests a past month after a gap, including across a year change', () => {
    expect(suggestNextDealingDay(['2026-03'], new Date(2026, 8, 23))).toBe('2026-09')
    expect(suggestNextDealingDay(['2026-10'], new Date(2027, 1, 5))).toBe('2027-02')
    expect(suggestNextDealingDay(['2026-08'], SEPT_2026)).toBe('2026-09')
    expect(suggestNextDealingDay(['2026-09'], SEPT_2026)).toBe('2026-10')
  })

  it('falls back to the current month when nothing is on record', () => {
    expect(suggestNextDealingDay([], SEPT_2026)).toBe('2026-09')
  })

  it('keeps numeric labels working: YYYYMM counts, a bare year does not', () => {
    expect(parseDealingMonth('202610')).toEqual({ year: 2026, month: 10 })
    expect(parseDealingMonth('2026')).toBeUndefined()
    expect(parseDealingMonth('2026-13')).toBeUndefined()
    expect(suggestNextDealingDay(['2026', '202610'], SEPT_2026)).toBe('2026-11')
    expect(suggestNextDealingDay(['2026', '2027'], SEPT_2026)).toBe('2026-09')
  })

  it('backs suggestNextMintPeriod on the mint history', () => {
    expect(suggestNextMintPeriod([{ period: '2026-09', amountRaw: '1' }, { period: 'launch', amountRaw: '1' }], SEPT_2026)).toBe(
      '2026-10',
    )
    expect(suggestNextMintPeriod([], SEPT_2026)).toBe('2026-09')
  })
})

describe('already issued', () => {
  const records = [
    { period: '202610', amountRaw: '1', sequence: 7 },
    { period: '2026-09', amountRaw: '2', sequence: 8 },
  ]

  it('matches a dealing day across label formats', () => {
    expect(sameDealingDay('2026-10', '202610')).toBe(true)
    expect(sameDealingDay('2026-10', '2026-11')).toBe(false)
    expect(sameDealingDay('launch', 'launch')).toBe(true)
  })

  it("finds the day's earlier issue but not the proposal itself", () => {
    expect(alreadyIssued(records, '2026-10', 99)?.sequence).toBe(7)
    expect(alreadyIssued(records, '2026-10', 7)).toBeUndefined()
    expect(alreadyIssued(records, '2026-11', 99)).toBeUndefined()
  })
})
