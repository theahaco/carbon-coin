import { describe, expect, it } from 'vitest'
import { encodeMemo } from 'xrpl'
import { buildRegisterLedger, lastDeliveryLine, orderRefOf } from '../../src/lib/ledger'
import { describeProposal } from '../../src/lib/preview'
import type { MptPayment } from '../../src/lib/xrplClient'

const ISSUANCE = '0140588A60AD414AC57B9EE936049173E9CF215CB1BA2DE9'

const REGISTER = 'r9FBRP7L5gnqG7LiHw1SqDwZ14V9rXhEHY'
const DESK = 'rf8KiuvfVqZ3GkwmQTUCyWySAW1Pv5qEVA'
const INVESTOR = 'rLBbnqV3WCc2C28zhG8BdEr4TRJK8bgARY'

function pay(destination: string, amountRaw: string, ledgerIndex: number, memos: MptPayment['memos'] = []): MptPayment {
  return { destination, amountRaw, ledgerIndex, hash: `H${ledgerIndex}`, memos }
}

describe('register ledger rows', () => {
  it('lists ISSUE, DELIVER and REDEEM rows newest first, with memos and contract-note figures', () => {
    const rows = buildRegisterLedger({
      issuer: REGISTER,
      desk: DESK,
      ticker: 'HQUAY',
      issuerPayments: [pay(DESK, '235187958000000', 10, [{ type: 'mint-period', data: '2026-10' }])],
      deskPayments: [
        pay(INVESTOR, '25000000000000', 12, [{ type: 'order-ref', data: 'ORD-2026-10-014' }]),
        pay(REGISTER, '1000000000', 14),
      ],
    })
    expect(rows.map((r) => r.stamp)).toEqual(['REDEEM', 'DELIVER', 'ISSUE'])
    expect(rows[2]).toMatchObject({
      title: 'Issued 235,187.958 HQUAY to the Dealing Desk',
      memo: 'DD 2026-10 · €2,450,000 ÷ €10.4172 (illustrative)',
      hash: 'H10',
    })
    expect(rows[2]!.offProcedure).toBeUndefined()
    expect(rows[1]).toMatchObject({ title: 'Delivered 25,000.000 HQUAY to rLBbnq…gARY', memo: 'ORD-2026-10-014' })
    expect(rows[0]).toMatchObject({ title: 'Returned 1.000 HQUAY to the Register for cancellation' })
  })

  it('flags issues that skip the Desk or carry no dealing day, and omits € when units differ from the note', () => {
    const rows = buildRegisterLedger({
      issuer: REGISTER,
      desk: DESK,
      ticker: 'HQUAY',
      issuerPayments: [pay(INVESTOR, '1000000000', 2, [{ type: 'mint-period', data: '2026-10' }]), pay(DESK, '1000000000', 1)],
      deskPayments: [],
    })
    expect(rows[0]).toMatchObject({ title: 'Issued 1.000 HQUAY directly to rLBbnq…gARY', memo: 'DD 2026-10', offProcedure: 'Skipped the Dealing Desk' })
    expect(rows[1]).toMatchObject({ memo: '(no dealing-day memo)', offProcedure: 'No dealing-day memo' })
  })

  it('prefers an order-ref memo, else the first text memo', () => {
    expect(orderRefOf([{ type: 'note', data: 'x' }, { type: 'order-ref', data: 'ORD-1' }])).toBe('ORD-1')
    expect(orderRefOf([{ type: 'note', data: 'x' }])).toBe('x')
    expect(orderRefOf([])).toBeUndefined()
  })

  it('flags the same issues Co-sign flags: a non-month dealing day and units off the contract note', () => {
    const issues = [
      pay(DESK, '3334890000000', 4, [{ type: 'mint-period', data: 'august 2026 NOAA total' }]),
      pay(DESK, '1000000000000', 3, [{ type: 'mint-period', data: '2026-10' }]),
      pay(DESK, '235187958000000', 2, [{ type: 'mint-period', data: '2026-10' }]),
      pay(INVESTOR, '235187958000000', 1, [{ type: 'mint-period', data: '2026-10' }]),
      pay(DESK, '235187958000000', 0),
    ]
    const rows = buildRegisterLedger({ issuer: REGISTER, desk: DESK, ticker: 'HQUAY', issuerPayments: issues, deskPayments: [] })
    expect(rows.map((row) => row.memo)).toEqual([
      'august 2026 NOAA total',
      'DD 2026-10',
      'DD 2026-10 · €2,450,000 ÷ €10.4172 (illustrative)',
      'DD 2026-10 · €2,450,000 ÷ €10.4172 (illustrative)',
      '(no dealing-day memo)',
    ])
    expect(rows.map((row) => row.offProcedure)).toEqual([
      "Dealing day isn't a YYYY-MM month",
      "Units don't match the contract note",
      undefined,
      'Skipped the Dealing Desk',
      'No dealing-day memo',
    ])
    const ctx = { ticker: 'HQUAY', mptIssuanceId: ISSUANCE, issuer: REGISTER, desk: DESK }
    for (const [i, issue] of issues.entries()) {
      const preview = describeProposal(
        {
          TransactionType: 'Payment',
          Account: REGISTER,
          Destination: issue.destination,
          Amount: { mpt_issuance_id: ISSUANCE, value: issue.amountRaw },
          Memos: issue.memos.map((memo) => encodeMemo(memo)),
        },
        ctx,
      )
      expect(Boolean(preview.offProcedure)).toBe(Boolean(rows[i]!.offProcedure))
    }
  })

  it("words the investor's last delivery as the handoff does", () => {
    expect(lastDeliveryLine('ORD-2026-09-006', new Date(2026, 9, 2))).toBe('Last delivery: order ORD-2026-09-006, dealing day 2026-09.')
    expect(lastDeliveryLine('custom-ref', new Date(2026, 8, 22))).toBe('Last delivery: order custom-ref, dealing day 2026-09.')
    expect(lastDeliveryLine(undefined, new Date(2026, 8, 22))).toBe('Last delivery: dealing day 2026-09.')
    expect(lastDeliveryLine('custom-ref', undefined)).toBe('Last delivery: order custom-ref.')
  })
})
