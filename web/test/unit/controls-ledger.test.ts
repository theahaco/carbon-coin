import { beforeAll, describe, expect, it } from 'vitest'
import {
  controlActionsOf,
  currentStop,
  pairReplacements,
  reasonOf,
  reasonWithoutRef,
  reissuesOf,
  replacementMemo,
  replacementOfClawback,
  replacementRefOf,
  stoppedHoldingNote,
  suggestReplacementRef,
  unfinishedReplacements,
} from '../../src/lib/controls'
import { buildRegisterLedger, buildRegisterLedgerEntries, groupRegisterLedger, type LedgerEntry } from '../../src/lib/ledger'
import { setLedgerScale } from '../../src/lib/units'
import { issuanceTransactionOf, type IssuanceTransaction, type MptPayment } from '../../src/lib/xrplClient'

const ISSUANCE = '014065D7B11826B116E4B189DDE0A405680FEFED641D1DDC'
const REGISTER = 'rH9PYrGRAfLJ3kJCPFrdHLULXf6yQMiw4y'
const DESK = 'rJZLs3cdQnHuf3fJPhC2bo3NghUbG7KWWB'
const LOST = 'rwwCKTRApRm4pWeqGmsNtaKSoooNUxdMVt'
const NEW = 'rLBbnqV3WCc2C28zhG8BdEr4TRJK8bgARY'
const OTHER = 'rKm2LxVbT8yQ2kLm6XcW1sZa9Nd3dVaQ'

beforeAll(() => setLedgerScale(3))

function control(type: string, ledgerIndex: number, opts: { holder?: string; flags?: number; data?: string; amountRaw?: string; account?: string } = {}): IssuanceTransaction {
  return {
    type,
    account: opts.account ?? REGISTER,
    holder: 'holder' in opts ? opts.holder : LOST,
    flags: opts.flags ?? 0,
    amountRaw: opts.amountRaw,
    memos: opts.data ? [{ type: 'reason', data: opts.data }] : [],
    ledgerIndex,
    hash: `T${ledgerIndex}`,
    date: new Date(2026, 7, ledgerIndex),
  }
}

const stop = (i: number, data?: string, holder = LOST) => control('MPTokenIssuanceSet', i, { flags: 1, data, holder })
const release = (i: number, data?: string, holder = LOST) => control('MPTokenIssuanceSet', i, { flags: 2, data, holder })
const claw = (i: number, amountRaw: string, data?: string, holder = LOST) => control('Clawback', i, { amountRaw, data, holder })

function pay(destination: string, amountRaw: string, ledgerIndex: number, memos: MptPayment['memos'] = []): MptPayment {
  return { destination, amountRaw, ledgerIndex, hash: `P${ledgerIndex}`, memos, date: new Date(2026, 7, ledgerIndex) }
}

const input = (transactions: IssuanceTransaction[], issuerPayments: MptPayment[] = [], deskPayments: MptPayment[] = []) => ({
  issuer: REGISTER,
  desk: DESK,
  ticker: 'HQUAY',
  issuerPayments,
  deskPayments,
  controls: controlActionsOf(transactions, REGISTER),
})

const group = (entries: LedgerEntry[], ref: string) => entries.find((e): e is Extract<LedgerEntry, { kind: 'group' }> => e.kind === 'group' && e.ref === ref)

describe('reading controls from the issuance history', () => {
  it("keeps the Register's per-holder stops, releases and clawbacks, newest first", () => {
    const actions = controlActionsOf(
      [
        stop(1, 'lost key'),
        release(2, 'key found'),
        claw(3, '5000', 'REPL-2026-001 · lost key'),
        // Not controls: a lock of the whole class, lock and unlock together, another sender, an admission.
        control('MPTokenIssuanceSet', 4, { flags: 1, holder: undefined }),
        control('MPTokenIssuanceSet', 5, { flags: 3 }),
        control('MPTokenIssuanceSet', 6, { flags: 1, account: OTHER }),
        control('MPTokenAuthorize', 7, {}),
      ],
      REGISTER,
    )
    expect(actions.map((a) => [a.kind, a.ledgerIndex])).toEqual([
      ['clawback', 3],
      ['release', 2],
      ['stop', 1],
    ])
    expect(actions[0]).toMatchObject({ replRef: 'REPL-2026-001', reason: 'REPL-2026-001 · lost key', amountRaw: '5000' })
  })

  it('reads what a clawback took from the metadata, and a payment its delivered amount', () => {
    const row = (tx: Record<string, unknown>, meta: Record<string, unknown>) => ({ tx: { ledger_index: 9, ...tx }, meta: { TransactionResult: 'tesSUCCESS', ...meta }, validated: true })
    const clawed = issuanceTransactionOf(
      row(
        { TransactionType: 'Clawback', Account: REGISTER, Holder: LOST, Amount: { mpt_issuance_id: ISSUANCE, value: '99999999' } },
        {
          AffectedNodes: [
            { ModifiedNode: { LedgerEntryType: 'MPToken', FinalFields: {}, PreviousFields: { MPTAmount: '986000' } } },
            { ModifiedNode: { LedgerEntryType: 'MPTokenIssuance', FinalFields: { OutstandingAmount: '10000' }, PreviousFields: { OutstandingAmount: '996000' } } },
          ],
        },
      ),
      ISSUANCE,
    )
    expect(clawed).toMatchObject({ type: 'Clawback', holder: LOST, amountRaw: '986000' })
    // The last units out of issue leave OutstandingAmount out of FinalFields.
    const last = issuanceTransactionOf(
      row(
        { TransactionType: 'Clawback', Account: REGISTER, Holder: LOST, Amount: { mpt_issuance_id: ISSUANCE, value: '5' } },
        { AffectedNodes: [{ ModifiedNode: { LedgerEntryType: 'MPTokenIssuance', FinalFields: {}, PreviousFields: { OutstandingAmount: '5' } } }] },
      ),
      ISSUANCE,
    )
    expect(last?.amountRaw).toBe('5')
    const paid = issuanceTransactionOf(
      row(
        { TransactionType: 'Payment', Account: REGISTER, Destination: NEW, Amount: { mpt_issuance_id: ISSUANCE, value: '7' } },
        { delivered_amount: { mpt_issuance_id: ISSUANCE, value: '7' } },
      ),
      ISSUANCE,
    )
    expect(paid).toMatchObject({ type: 'Payment', destination: NEW, amountRaw: '7' })
  })

  it('reads reasons and references from memos, and suggests the next reference for the year', () => {
    expect(reasonOf([{ type: 'note', data: 'x' }, { type: 'reason', data: ' lost key ' }])).toBe('lost key')
    expect(reasonOf([{ type: 'note', data: 'sanctions review' }])).toBe('sanctions review')
    expect(reasonOf([])).toBeUndefined()
    expect(replacementRefOf([replacementMemo('REPL-2026-004')])).toBe('REPL-2026-004')
    expect(replacementMemo('REPL-2026-004')).toEqual({ type: 'reason', data: 'REPL-2026-004 · lost key' })
    expect(reasonWithoutRef('REPL-2026-004 · lost key')).toBe('lost key')
    const now = new Date(2026, 8, 24)
    expect(suggestReplacementRef([], now)).toBe('REPL-2026-001')
    expect(suggestReplacementRef([[replacementMemo('REPL-2026-003')], [replacementMemo('REPL-2025-009')]], now)).toBe('REPL-2026-004')
  })

  it("knows a holding's current stop and the replacements still waiting for their re-issue", () => {
    const actions = controlActionsOf([stop(1, 'lost key'), release(2), stop(3, 'lost key'), claw(4, '5000', 'REPL-2026-001 · lost key')], REGISTER)
    expect(currentStop(actions, LOST)?.ledgerIndex).toBe(3)
    expect(currentStop(controlActionsOf([stop(1), release(2)], REGISTER), LOST)).toBeUndefined()
    const { pairs } = pairReplacements(actions, [])
    expect(unfinishedReplacements(pairs).map((p) => [p.ref, p.stop?.ledgerIndex])).toEqual([['REPL-2026-001', 3]])
  })

  it("tells a stopped holder what the Register did, and promises nothing about the units", () => {
    const paused = 'Transfers paused on this holding while the register reviews it.'
    expect(stoppedHoldingNote([], LOST, 'HQUAY')).toBe(paused)
    expect(stoppedHoldingNote(controlActionsOf([stop(1, 'lost key')], REGISTER), LOST, 'HQUAY')).toBe(paused)
    // After step 1 of a replacement the holding is empty and still stopped.
    const replaced = controlActionsOf([stop(1, 'lost key'), claw(2, '12500', 'REPL-2026-004 · lost key')], REGISTER)
    expect(stoppedHoldingNote(replaced, LOST, 'HQUAY')).toBe(
      'The Register clawed back 12.500 HQUAY from this holding on 02 Aug 2026 for lost-key replacement REPL-2026-004. Transfers stay paused on it.',
    )
    expect(stoppedHoldingNote(controlActionsOf([stop(1), claw(2, '500')], REGISTER), LOST, 'HQUAY')).toBe(
      'The Register clawed back 0.500 HQUAY from this holding on 02 Aug 2026. Transfers stay paused on it.',
    )
    // A clawback before the stop now in place, or from another holding, isn't this stop's.
    expect(stoppedHoldingNote(controlActionsOf([stop(1), claw(2, '500'), release(3), stop(4)], REGISTER), LOST, 'HQUAY')).toBe(paused)
    expect(stoppedHoldingNote(controlActionsOf([stop(1), claw(2, '500', undefined, OTHER)], REGISTER), LOST, 'HQUAY')).toBe(paused)
  })

  it('finds the replacement a landed clawback started by the clawback itself, not by a reference an earlier one shares', () => {
    // REPL-2026-001 was already clawed back from OTHER and re-issued; a later clawback from LOST reuses the reference.
    const earlier = { ...claw(1, '5000', 'REPL-2026-001 · lost key', OTHER), sequence: 40 }
    const later = { ...claw(5, '9000', 'REPL-2026-001 · lost key'), sequence: 42 }
    const actions = controlActionsOf([earlier, later], REGISTER)
    const { pairs } = pairReplacements(actions, reissuesOf([pay(NEW, '5000', 2, [replacementMemo('REPL-2026-001')])], DESK))
    expect(pairs.find((p) => p.ref === 'REPL-2026-001')?.clawback.holder).toBe(OTHER)
    const mine = replacementOfClawback(pairs, { sequence: 42 })
    expect(mine?.clawback).toMatchObject({ holder: LOST, amountRaw: '9000' })
    expect(mine?.reissue).toBeUndefined()
    expect(replacementOfClawback(pairs, { hash: 'T5' })?.clawback.holder).toBe(LOST)
    expect(replacementOfClawback(pairs, { sequence: 41 })).toBeUndefined()
    expect(replacementOfClawback(pairs, {})).toBeUndefined()
  })
})

describe('register ledger: stop-transfers, releases and grouped replacements', () => {
  it('shows STOP and RELEASE rows with their reasons, and flags a stop without one', () => {
    const rows = buildRegisterLedger(input([stop(1, 'sanctions review'), release(2, 'review closed'), stop(3, undefined, OTHER)]))
    expect(rows).toMatchObject([
      { stamp: 'STOP', title: 'Stop-transfer on rKm2Lx…dVaQ', memo: '(no reason memo)', offProcedure: 'No reason memo' },
      { stamp: 'RELEASE', title: 'Released the stop-transfer on rwwCKT…dMVt', memo: 'reason: review closed' },
      { stamp: 'STOP', title: 'Stop-transfer on rwwCKT…dMVt', memo: 'reason: sanctions review' },
    ])
    expect(rows[1]!.offProcedure).toBeUndefined()
    expect(rows[2]!.offProcedure).toBeUndefined()
  })

  it('groups the stop, the clawback and the paired re-issue under their reference, in the order they happened', () => {
    const entries = buildRegisterLedgerEntries(
      input(
        [stop(14, 'lost key'), claw(18, '8000000', 'REPL-2026-003 · lost key')],
        [pay(DESK, '159247000', 30, [{ type: 'mint-period', data: '2026-09' }]), pay(NEW, '8000000', 19, [replacementMemo('REPL-2026-003')])],
        [pay(OTHER, '1000', 31, [{ type: 'order-ref', data: 'ORD-2026-09-007' }])],
      ),
    )
    expect(entries.map((e) => (e.kind === 'row' ? e.row.stamp : e.label))).toEqual(['DELIVER', 'ISSUE', 'Lost-key replacement · REPL-2026-003'])
    const replacement = group(entries, 'REPL-2026-003')!
    expect(replacement.rows).toMatchObject([
      { stamp: 'STOP', title: 'Stop-transfer on rwwCKT…dMVt', memo: 'reason: lost key' },
      { stamp: 'REPLACE', title: 'Clawed back 8,000.000 from rwwCKT…dMVt', memo: 'REPL-2026-003', hash: 'T18' },
      { stamp: 'REPLACE', title: 'Re-issued 8,000.000 to rLBbnq…gARY', memo: 'REPL-2026-003', hash: 'P19' },
    ])
    expect(replacement.rows.every((row) => row.offProcedure === undefined)).toBe(true)
  })

  it('places a replacement where its newest row falls, and notes a re-issue that is not on the ledger yet', () => {
    const entries = buildRegisterLedgerEntries(
      input([stop(10, 'lost key'), claw(12, '8000000', 'REPL-2026-004 · lost key')], [pay(DESK, '1000', 11, [{ type: 'mint-period', data: '2026-10' }])]),
    )
    expect(entries.map((e) => (e.kind === 'row' ? e.row.stamp : e.label))).toEqual(['Lost-key replacement · REPL-2026-004 · re-issue pending', 'ISSUE'])
    expect(group(entries, 'REPL-2026-004')!.rows.map((r) => r.stamp)).toEqual(['STOP', 'REPLACE'])
  })

  it("leaves a stop that a release lifted before the clawback out of the group", () => {
    const entries = buildRegisterLedgerEntries(input([stop(1, 'lost key'), release(2), claw(3, '5', 'REPL-2026-001 · lost key')]))
    expect(entries.map((e) => (e.kind === 'row' ? e.row.stamp : e.label))).toEqual(['Lost-key replacement · REPL-2026-001 · re-issue pending', 'RELEASE', 'STOP'])
  })

  it('keeps an unpaired re-issue an OFF-PROCEDURE issue: no clawback, different units, or a second re-issue of one clawback', () => {
    const rows = buildRegisterLedger(
      input(
        [claw(5, '8000000', 'REPL-2026-003 · lost key')],
        [
          pay(NEW, '8000000', 6, [replacementMemo('REPL-2026-003')]),
          pay(OTHER, '8000000', 7, [replacementMemo('REPL-2026-003')]),
          pay(OTHER, '9000000', 8, [replacementMemo('REPL-2026-009')]),
        ],
      ),
    )
    expect(rows.map((r) => [r.stamp, r.memo, r.offProcedure, r.replRef])).toEqual([
      ['ISSUE', 'REPL-2026-009', 'No matching claw-back', undefined],
      ['ISSUE', 'REPL-2026-003', 'No matching claw-back', undefined],
      ['REPLACE', 'REPL-2026-003', undefined, 'REPL-2026-003'],
      ['REPLACE', 'REPL-2026-003', undefined, 'REPL-2026-003'],
    ])
    // A re-issue before its clawback doesn't pair either.
    const early = buildRegisterLedger(input([claw(9, '5', 'REPL-2026-001 · lost key')], [pay(NEW, '5', 8, [replacementMemo('REPL-2026-001')])]))
    expect(early.find((r) => r.hash === 'P8')).toMatchObject({ stamp: 'ISSUE', offProcedure: 'No matching claw-back' })
  })

  it('flags a clawback without a replacement reference, or without any memo', () => {
    const rows = buildRegisterLedger(input([claw(1, '5000', 'court order'), claw(2, '5000')]))
    expect(rows).toMatchObject([
      { stamp: 'CLAWBACK', title: 'Clawed back 5.000 HQUAY from rwwCKT…dMVt', memo: '(no reason memo)', offProcedure: 'No reason memo' },
      { stamp: 'CLAWBACK', memo: 'reason: court order', offProcedure: 'No replacement reference' },
    ])
    expect(groupRegisterLedger(rows).every((e) => e.kind === 'row')).toBe(true)
  })

  it('pairs a re-issue only with a clawback of the same units, earliest first', () => {
    const actions = controlActionsOf([claw(1, '5', 'REPL-2026-001 · lost key'), claw(2, '7', 'REPL-2026-001 · lost key')], REGISTER)
    const { pairs, unmatched } = pairReplacements(actions, reissuesOf([pay(NEW, '7', 3, [replacementMemo('REPL-2026-001')]), pay(DESK, '5', 4, [replacementMemo('REPL-2026-001')])], DESK))
    expect(pairs.map((p) => [p.clawback.amountRaw, p.reissue?.amountRaw])).toEqual([
      ['5', undefined],
      ['7', '7'],
    ])
    // A payment to the Desk is never a re-issue.
    expect(unmatched).toEqual([])
  })
})
