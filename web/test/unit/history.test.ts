import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Client, encodeMemo } from 'xrpl'
import { getMintHistory } from '../../src/lib/xrplClient'
import { fromGton, toGton } from '../../src/lib/gton'

beforeEach(() => {
  vi.spyOn(Client.prototype, 'connect').mockResolvedValue()
})
afterEach(() => vi.restoreAllMocks())

describe('typed mint history and display units', () => {
  it('uses delivered amounts and skips binary memos and unknown historical delivery', async () => {
    const history = vi.spyOn(Client.prototype, 'getMptPaymentHistory').mockResolvedValue({
      ledgerIndexMin: 1,
      ledgerIndexMax: 42,
      payments: [
        {
          transaction: {
            Memos: [{ Memo: { MemoData: 'FF' } }, encodeMemo({ type: 'mint-period', data: '2026' })],
          },
          deliveredAmount: '3',
          hash: 'hash',
        },
        { transaction: { Memos: [encodeMemo({ type: 'mint-period', data: '2027' })] } },
      ],
    } as never)
    expect(await getMintHistory('issuer', 'issuance')).toEqual([
      { period: '2026', amountRaw: '3', hash: 'hash' },
    ])
    expect(history).toHaveBeenCalledWith('issuer', 'issuance')
  })
  it('preserves exact raw amounts at supply scale and rejects excess precision', () => {
    const raw = '9223372036854775807'
    expect(fromGton(toGton(raw))).toBe(raw)
    expect(toGton('1000000001')).toBe('1.000000001')
    expect(() => fromGton('1.0000000001')).toThrow()
  })
})
