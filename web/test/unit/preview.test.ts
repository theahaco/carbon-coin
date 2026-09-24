import { describe, expect, it } from 'vitest'
import { encodeMemo } from 'xrpl'
import { describeProposal, FINER_THAN_UNITS, OFF_PROCEDURE_SKIPS_DESK } from '../../src/lib/preview'

const ISSUANCE = '0140588A60AD414AC57B9EE936049173E9CF215CB1BA2DE9'
const REGISTER = 'r9FBRP7L5gnqG7LiHw1SqDwZ14V9rXhEHY'
const DESK = 'rf8KiuvfVqZ3GkwmQTUCyWySAW1Pv5qEVA'
const INVESTOR = 'rLBbnqV3WCc2C28zhG8BdEr4TRJK8bgARY'
const ctx = { ticker: 'HQUAY', mptIssuanceId: ISSUANCE, issuer: REGISTER, desk: DESK }

function payment(account: string, destination: string, value: string, memos: Array<{ type: string; data: string }> = []) {
  return {
    TransactionType: 'Payment',
    Account: account,
    Destination: destination,
    Amount: { mpt_issuance_id: ISSUANCE, value },
    Fee: '36',
    Sequence: 5,
    SigningPubKey: '',
    ...(memos.length ? { Memos: memos.map((m) => encodeMemo(m)) } : {}),
  }
}

const NOTE_UNITS_2026_10 = '235187958000000'

describe('co-sign sentences, decoded from the transaction', () => {
  it('reads a Register issue to the Desk with its dealing day and contract note', () => {
    const preview = describeProposal(payment(REGISTER, DESK, NOTE_UNITS_2026_10, [{ type: 'mint-period', data: '2026-10' }]), ctx)
    expect(preview.kind).toBe('issue')
    expect(preview.keySet).toBe('register')
    expect(preview.sentence).toBe('Issue 235,187.958 HQUAY to the Dealing Desk for dealing day 2026-10 (€2,450,000 ÷ NAV €10.4172)')
    expect(preview.doneSentence).toBe('235,187.958 HQUAY issued to the Dealing Desk for dealing day 2026-10.')
    expect(preview.offProcedure).toBeUndefined()
    expect(preview.note?.day).toBe('2026-10')
  })

  it('reads a Dealing Desk delivery with its order reference', () => {
    const preview = describeProposal(payment(DESK, INVESTOR, '25000000000000', [{ type: 'order-ref', data: 'ORD-2026-10-014' }]), ctx)
    expect(preview.kind).toBe('deliver')
    expect(preview.keySet).toBe('desk')
    expect(preview.sentence).toBe('Deliver 25,000.000 HQUAY to rLBbnq…gARY · order ORD-2026-10-014')
    expect(preview.doneSentence).toBe('25,000.000 HQUAY delivered to rLBbnq…gARY, order ORD-2026-10-014.')
    expect(preview.offProcedure).toBeUndefined()
  })

  it('says when a delivery carries no order reference', () => {
    expect(describeProposal(payment(DESK, INVESTOR, '1000000'), ctx).sentence).toBe('Deliver 0.001 HQUAY to rLBbnq…gARY · no order reference')
  })

  it('reads a Desk payment back to the Register as a return for cancellation', () => {
    const preview = describeProposal(payment(DESK, REGISTER, '1000000000'), ctx)
    expect(preview.kind).toBe('return')
    expect(preview.sentence).toBe('Return 1.000 HQUAY to the Register for cancellation')
  })
})

describe('OFF-PROCEDURE: valid, signable, flagged', () => {
  it('flags a Register issue that skips the Dealing Desk', () => {
    const preview = describeProposal(payment(REGISTER, INVESTOR, '25000000000000', [{ type: 'mint-period', data: '2026-10' }]), ctx)
    expect(preview.kind).toBe('issue')
    expect(preview.sentence).toBe('Issue 25,000.000 HQUAY directly to rLBbnq…gARY')
    expect(preview.offProcedure).toBe(OFF_PROCEDURE_SKIPS_DESK)
    expect(OFF_PROCEDURE_SKIPS_DESK).toBe(
      'the units go straight to an investor and skip the Dealing Desk. Register issues normally go only to the Desk.',
    )
    expect(preview.note).toBeUndefined()
  })

  it('flags an issue whose units differ from the contract note, without quoting the note as its price', () => {
    const preview = describeProposal(payment(REGISTER, DESK, '1000000000000', [{ type: 'mint-period', data: '2026-10' }]), ctx)
    expect(preview.sentence).toBe('Issue 1,000.000 HQUAY to the Dealing Desk for dealing day 2026-10')
    expect(preview.offProcedure).toMatch(/don't match the contract note for dealing day 2026-10 \(235,187\.958 HQUAY at €2,450,000 ÷ NAV €10\.4172, illustrative\)/)
    expect(preview.note).toBeUndefined()
  })

  it('shows an amount finer than 3 decimals exactly, and flags it, for deliveries and issues alike', () => {
    const deliver = describeProposal(payment(DESK, INVESTOR, '25000000999999', [{ type: 'order-ref', data: 'ORD-1' }]), ctx)
    expect(deliver.sentence).toBe('Deliver 25,000.000999999 HQUAY to rLBbnq…gARY · order ORD-1')
    expect(deliver.offProcedure).toBe(FINER_THAN_UNITS)
    const issue = describeProposal(payment(REGISTER, DESK, '235187958999999', [{ type: 'mint-period', data: '2026-10' }]), ctx)
    expect(issue.sentence).toBe('Issue 235,187.958999999 HQUAY to the Dealing Desk for dealing day 2026-10')
    expect(issue.offProcedure).toBe(FINER_THAN_UNITS)
    expect(describeProposal(payment(DESK, REGISTER, '1000000001'), ctx).offProcedure).toBe(FINER_THAN_UNITS)
  })

  it('flags an issue with no dealing day', () => {
    const preview = describeProposal(payment(REGISTER, DESK, NOTE_UNITS_2026_10), ctx)
    expect(preview.sentence).toBe('Issue 235,187.958 HQUAY to the Dealing Desk')
    expect(preview.offProcedure).toMatch(/no dealing-day memo/)
  })
})

describe('UNRECOGNISED: do not sign', () => {
  it('rejects any non-Payment from a known account, and lists the raw fields', () => {
    const preview = describeProposal(
      { TransactionType: 'MPTokenIssuanceSet', Account: REGISTER, MPTokenIssuanceID: ISSUANCE, Flags: 1, SigningPubKey: '' },
      ctx,
    )
    expect(preview.kind).toBe('unrecognised')
    expect(preview.keySet).toBeUndefined()
    expect(preview.sentence).toBe("This transaction doesn't match any Harrowquay procedure.")
    expect(preview.rawFields).toContainEqual(['TransactionType', 'MPTokenIssuanceSet'])
    expect(preview.rawFields).toContainEqual(['Flags', '0x00000001'])
    expect(preview.rawFields.map(([key]) => key)).not.toContain('SigningPubKey')
    // A missing Holder is what makes this lock the whole class: the record says so, as the handoff's raw box does.
    expect(preview.rawFields.slice(-2)).toEqual([
      ['Holder', '(none)'],
      ['Memos', '(none)'],
    ])
  })

  it('names a missing Holder only where one decides what the transaction does, and a missing memo always', () => {
    // A Payment from an account that's neither the Register nor the Desk, with no memo.
    const stray = describeProposal(payment(INVESTOR, DESK, '1000000'), ctx)
    expect(stray.kind).toBe('unrecognised')
    expect(stray.rawFields).toContainEqual(['Memos', '(none)'])
    expect(stray.rawFields.map(([key]) => key)).not.toContain('Holder')
    const withHolder = describeProposal({ TransactionType: 'Clawback', Account: DESK, Holder: INVESTOR, Amount: '1' }, ctx)
    expect(withHolder.kind).toBe('unrecognised')
    expect(withHolder.rawFields.filter(([key]) => key === 'Holder')).toEqual([['Holder', INVESTOR]])
  })

  it('rejects a Payment from an unknown account', () => {
    expect(describeProposal(payment(INVESTOR, DESK, '1000000'), ctx).kind).toBe('unrecognised')
  })

  it('rejects another asset, XRP, a bad amount or a self-payment', () => {
    const other = { ...payment(REGISTER, DESK, '1000000'), Amount: { mpt_issuance_id: '00'.repeat(24), value: '1000000' } }
    const xrp = { ...payment(DESK, INVESTOR, '1'), Amount: '1000000' }
    expect(describeProposal(other, ctx).kind).toBe('unrecognised')
    expect(describeProposal(xrp, ctx).kind).toBe('unrecognised')
    expect(describeProposal(payment(DESK, INVESTOR, '0'), ctx).kind).toBe('unrecognised')
    expect(describeProposal(payment(DESK, INVESTOR, '1.5'), ctx).kind).toBe('unrecognised')
    expect(describeProposal(payment(DESK, DESK, '1000000'), ctx).kind).toBe('unrecognised')
  })

  it('summarises signatures and decodes memos in the raw fields', () => {
    const tx = {
      ...payment(REGISTER, DESK, '1', [{ type: 'mint-period', data: '2026-10' }]),
      TransactionType: 'Clawback',
      Signers: [{ Signer: { Account: 'rX', SigningPubKey: '02', TxnSignature: 'AA' } }],
    }
    const fields = Object.fromEntries(describeProposal(tx, ctx).rawFields)
    expect(fields.Signers).toBe('1 signature')
    expect(fields.Memos).toBe('mint-period: 2026-10')
  })
})
