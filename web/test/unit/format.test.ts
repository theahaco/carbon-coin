import { describe, expect, it } from 'vitest'
import { formatDate, formatShortDate } from '../../src/lib/format'

describe('dates', () => {
  it('always use three-letter months, including September', () => {
    expect(formatDate(new Date(2026, 8, 1))).toBe('01 Sep 2026')
    expect(formatDate(new Date(2026, 5, 22))).toBe('22 Jun 2026')
    expect(formatShortDate(new Date(2026, 8, 22), new Date(2026, 11, 31))).toBe('22 Sep')
    expect(formatShortDate(new Date(2025, 11, 3), new Date(2026, 0, 1))).toBe('03 Dec 2025')
  })
})
