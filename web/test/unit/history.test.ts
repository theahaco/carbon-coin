import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Client, encodeMemo } from 'xrpl'
import { getMintHistory, getOutgoingMptPayments } from '../../src/lib/xrplClient'
import { buildRegisterLedger } from '../../src/lib/ledger'
import { formatUnits, parseUnits } from '../../src/lib/units'

const ISSUANCE = '013FF064D26B0039BF8C5440F2F6A96AD315F996B25EF837'
const REGISTER = 'rLBbnqV3WCc2C28zhG8BdEr4TRJK8bgARY'
const DESK = 'rB6b46dDoxhJtnJ52w5BtErYBazapCpCAD'
const INVESTOR = 'rUTE43GKdqLK3RkyBmKdczRdQFDSWCceaQ'

/**
 * A row exactly as account_tx API v1 returns it: `{ meta, tx, validated }`,
 * with the hash, ledger index and close time inside `tx` and no top-level
 * ledger_index.
 */
function v1Row(account: string, destination: string, value: string, ledgerIndex: number, sequence: number, memos: Array<{ type: string; data: string }>) {
  return {
    meta: { TransactionResult: 'tesSUCCESS', delivered_amount: { mpt_issuance_id: ISSUANCE, value } },
    tx: {
      TransactionType: 'Payment',
      Account: account,
      Destination: destination,
      Amount: { mpt_issuance_id: ISSUANCE, value },
      Sequence: sequence,
      Memos: memos.map((memo) => encodeMemo(memo)),
      hash: `HASH${ledgerIndex}`,
      ledger_index: ledgerIndex,
      date: 800_000_000 + ledgerIndex,
    },
    validated: true,
  }
}

/** Answers the SDK's own `ledger` and `account_tx` requests from canned v1 rows. */
function mockV1History(rowsByAccount: Record<string, unknown[]>) {
  return vi.spyOn(Client.prototype, 'request').mockImplementation((async (req: { command: string; account?: string }) => {
    if (req.command === 'ledger') return { result: { ledger_index: 21_000_000 } }
    if (req.command === 'account_tx') {
      return { result: { ledger_index_min: 1, ledger_index_max: 21_000_000, transactions: rowsByAccount[req.account ?? ''] ?? [] } }
    }
    throw new Error(`unexpected ${req.command}`)
  }) as never)
}

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
            Destination: 'rDesk',
            Sequence: 7,
            date: 800_000_000,
            Memos: [{ Memo: { MemoData: 'FF' } }, encodeMemo({ type: 'mint-period', data: '2026' })],
          },
          deliveredAmount: '3',
          hash: 'hash',
          ledgerIndex: 40,
        },
        { transaction: { Memos: [encodeMemo({ type: 'mint-period', data: '2027' })] } },
      ],
    } as never)
    expect(await getMintHistory('issuer', 'issuance')).toEqual([
      {
        period: '2026',
        amountRaw: '3',
        hash: 'hash',
        destination: 'rDesk',
        ledgerIndex: 40,
        sequence: 7,
        // XRPL close time 800,000,000 s after 2000-01-01 = 2025-05-08T06:13:20Z.
        date: new Date('2025-05-08T06:13:20Z'),
      },
    ])
    expect(history).toHaveBeenCalledWith('issuer', 'issuance')
  })
  it('round-trips 3 dp amounts at the ledger scale, floors display, and rejects excess precision', () => {
    expect(parseUnits(formatUnits('9223372036854000000'))).toBe('9223372036854000000')
    expect(formatUnits('9223372036854775807')).toBe('9,223,372,036.854')
    expect(formatUnits('1000000001')).toBe('1.000')
    expect(() => parseUnits('1.0001')).toThrow()
  })

  it('reads the ledger index from v1 rows, so the register ledger really is newest first', async () => {
    mockV1History({
      [REGISTER]: [v1Row(REGISTER, DESK, '3334890000000', 20_969_700, 20_967_527, [{ type: 'mint-period', data: '2026-09' }])],
      [DESK]: [v1Row(DESK, INVESTOR, '42000000000', 20_969_910, 20_967_541, [{ type: 'order-ref', data: 'ORD-2026-09-001' }])],
    })
    const [issuerPayments, deskPayments] = await Promise.all([
      getOutgoingMptPayments(REGISTER, ISSUANCE),
      getOutgoingMptPayments(DESK, ISSUANCE),
    ])
    expect(issuerPayments[0]).toMatchObject({ ledgerIndex: 20_969_700, hash: 'HASH20969700', sequence: 20_967_527 })
    expect(deskPayments[0]).toMatchObject({ ledgerIndex: 20_969_910, hash: 'HASH20969910' })
    const rows = buildRegisterLedger({ issuerPayments, deskPayments, issuer: REGISTER, desk: DESK, ticker: 'HQUAY' })
    // The delivery is in the later ledger, so it sits above the issue.
    expect(rows.map((row) => row.stamp)).toEqual(['DELIVER', 'ISSUE'])
  })
})
