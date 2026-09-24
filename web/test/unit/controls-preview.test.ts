import { beforeAll, describe, expect, it } from 'vitest'
import { encodeMemo } from 'xrpl'
import {
  controlNotice,
  lockChangeOf,
  reasonMemo,
  replacementMemo,
  type ControlAction,
  type Reissue,
} from '../../src/lib/controls'
import { CLAWBACK_RESULT_MEANING, problemCopy, problemOptionsFor, STOP_RESULT_MEANING } from '../../src/lib/outcome'
import {
  describeProposal,
  OFF_PROCEDURE_NO_REASON,
  OFF_PROCEDURE_NO_REPL,
  OFF_PROCEDURE_SKIPS_DESK,
  type ProposalContext,
} from '../../src/lib/preview'
import { setLedgerScale } from '../../src/lib/units'
import { isSameProposal } from '../../src/lib/xrplClient'

const ISSUANCE = '014065D7B11826B116E4B189DDE0A405680FEFED641D1DDC'
const REGISTER = 'rH9PYrGRAfLJ3kJCPFrdHLULXf6yQMiw4y'
const DESK = 'rJZLs3cdQnHuf3fJPhC2bo3NghUbG7KWWB'
const LOST = 'rwwCKTRApRm4pWeqGmsNtaKSoooNUxdMVt'
const NEW = 'rLBbnqV3WCc2C28zhG8BdEr4TRJK8bgARY'
const ctx: ProposalContext = { ticker: 'HQUAY', mptIssuanceId: ISSUANCE, issuer: REGISTER, desk: DESK }

// The Phase 2 issuance: AssetScale 3, so 12,500.000 units are 12500000 raw.
beforeAll(() => setLedgerScale(3))

type Memo = { type: string; data: string }
const memos = (list: Memo[] | undefined) => (list ? { Memos: list.map((m) => encodeMemo(m)) } : {})

function lockTx(opts: { flags?: unknown; holder?: string; account?: string; memos?: Memo[]; extra?: Record<string, unknown> } = {}) {
  return {
    TransactionType: 'MPTokenIssuanceSet',
    Account: opts.account ?? REGISTER,
    MPTokenIssuanceID: ISSUANCE,
    ...(opts.holder === '' ? {} : { Holder: opts.holder ?? LOST }),
    Flags: opts.flags ?? 1,
    Fee: '36',
    Sequence: 9,
    SigningPubKey: '',
    ...memos(opts.memos),
    ...opts.extra,
  }
}

function clawbackTx(opts: { value?: string; holder?: string; account?: string; issuance?: string; memos?: Memo[] } = {}) {
  return {
    TransactionType: 'Clawback',
    Account: opts.account ?? REGISTER,
    ...(opts.holder === '' ? {} : { Holder: opts.holder ?? LOST }),
    Amount: { mpt_issuance_id: opts.issuance ?? ISSUANCE, value: opts.value ?? '12500000' },
    Fee: '36',
    Sequence: 10,
    SigningPubKey: '',
    ...memos(opts.memos),
  }
}

function reissueTx(opts: { value?: string; destination?: string; memos?: Memo[]; sequence?: number } = {}) {
  return {
    TransactionType: 'Payment',
    Account: REGISTER,
    Destination: opts.destination ?? NEW,
    Amount: { mpt_issuance_id: ISSUANCE, value: opts.value ?? '12500000' },
    Fee: '36',
    Sequence: opts.sequence ?? 11,
    SigningPubKey: '',
    ...memos(opts.memos ?? [replacementMemo('REPL-2026-004')]),
  }
}

const clawback = (ref: string | undefined, amountRaw: string, ledgerIndex: number): ControlAction => ({
  kind: 'clawback',
  holder: LOST,
  memos: ref ? [replacementMemo(ref)] : [],
  reason: ref ? `${ref} · lost key` : undefined,
  replRef: ref,
  amountRaw,
  ledgerIndex,
  hash: `C${ledgerIndex}`,
  date: new Date(2026, 8, 18),
})

const reissue = (ref: string, amountRaw: string, ledgerIndex: number, sequence: number, destination = NEW): Reissue => ({
  destination,
  amountRaw,
  replRef: ref,
  ledgerIndex,
  sequence,
  hash: `R${ledgerIndex}`,
})

describe('STOP and RELEASE on Co-sign', () => {
  it('reads a stop-transfer with a reason memo as the handoff words it', () => {
    const preview = describeProposal(lockTx({ memos: [reasonMemo('lost key')] }), ctx)
    expect(preview).toMatchObject({
      kind: 'stop',
      keySet: 'register',
      holder: LOST,
      reason: 'lost key',
      sentence: 'Stop-transfer on rwwCKT…dMVt (reason: lost key)',
      doneSentence: 'Stop-transfer in place on rwwCKT…dMVt.',
    })
    expect(preview.offProcedure).toBeUndefined()
  })

  it('flags a stop with no reason memo as OFF-PROCEDURE, still signable', () => {
    const preview = describeProposal(lockTx(), ctx)
    expect(preview).toMatchObject({ kind: 'stop', keySet: 'register', sentence: 'Stop-transfer on rwwCKT…dMVt', offProcedure: OFF_PROCEDURE_NO_REASON })
    expect(OFF_PROCEDURE_NO_REASON).toBe('there is no reason memo.')
    // A reason in an untyped memo still counts.
    expect(describeProposal(lockTx({ memos: [{ type: 'note', data: 'sanctions review' }] }), ctx).offProcedure).toBeUndefined()
  })

  it('reads a release, with or without a memo, and never flags it', () => {
    const preview = describeProposal(lockTx({ flags: 2, memos: [reasonMemo('key found')] }), ctx)
    expect(preview).toMatchObject({
      kind: 'release',
      keySet: 'register',
      sentence: 'Release the stop-transfer on rwwCKT…dMVt (reason: key found)',
      doneSentence: 'Stop-transfer released on rwwCKT…dMVt.',
    })
    expect(preview.offProcedure).toBeUndefined()
    expect(describeProposal(lockTx({ flags: 2 }), ctx)).toMatchObject({ kind: 'release', sentence: 'Release the stop-transfer on rwwCKT…dMVt' })
  })

  it('reads the flags in either form, ignoring tfFullyCanonicalSig', () => {
    expect(describeProposal(lockTx({ flags: { tfMPTLock: true } }), ctx).kind).toBe('stop')
    expect(describeProposal(lockTx({ flags: { tfMPTUnlock: true } }), ctx).kind).toBe('release')
    expect(describeProposal(lockTx({ flags: 0x80000001 }), ctx).kind).toBe('stop')
    expect(lockChangeOf(3)).toBeUndefined()
    expect(lockChangeOf(0)).toBeUndefined()
    expect(lockChangeOf({ tfMPTLock: true, tfMPTUnlock: true })).toBeUndefined()
  })

  it('keeps a lock of the whole class (a dealing suspension) and every other shape UNRECOGNISED', () => {
    // No Holder: it would lock or unlock the whole class. Never proposed here.
    expect(describeProposal(lockTx({ holder: '' }), ctx).kind).toBe('unrecognised')
    expect(describeProposal(lockTx({ holder: '', flags: 2 }), ctx).kind).toBe('unrecognised')
    expect(describeProposal(lockTx({ flags: 3 }), ctx).kind).toBe('unrecognised')
    expect(describeProposal(lockTx({ flags: 0 }), ctx).kind).toBe('unrecognised')
    expect(describeProposal(lockTx({ account: DESK }), ctx).kind).toBe('unrecognised')
    expect(describeProposal(lockTx({ holder: REGISTER }), ctx).kind).toBe('unrecognised')
    expect(describeProposal({ ...lockTx(), MPTokenIssuanceID: '0'.repeat(48) }, ctx).kind).toBe('unrecognised')
    expect(describeProposal(lockTx({ extra: { MPTokenMetadata: 'AB' } }), ctx).kind).toBe('unrecognised')
  })
})

describe('REPLACE on Co-sign: the clawback', () => {
  it('reads a clawback carrying a REPL reference as the first leg of a replacement', () => {
    const preview = describeProposal(clawbackTx({ memos: [replacementMemo('REPL-2026-004')] }), ctx)
    expect(preview).toMatchObject({
      kind: 'clawback',
      keySet: 'register',
      holder: LOST,
      amountRaw: '12500000',
      replRef: 'REPL-2026-004',
      reason: 'REPL-2026-004 · lost key',
      sentence: 'Claw back 12,500.000 HQUAY from rwwCKT…dMVt · lost-key replacement REPL-2026-004',
      doneSentence: '12,500.000 HQUAY clawed back from rwwCKT…dMVt, replacement REPL-2026-004.',
    })
    expect(preview.offProcedure).toBeUndefined()
  })

  it('flags a clawback with no reason memo, or with a reason but no REPL reference', () => {
    expect(describeProposal(clawbackTx(), ctx).offProcedure).toBe(OFF_PROCEDURE_NO_REASON)
    const noRef = describeProposal(clawbackTx({ memos: [reasonMemo('court order')] }), ctx)
    expect(noRef).toMatchObject({ kind: 'clawback', sentence: 'Claw back 12,500.000 HQUAY from rwwCKT…dMVt (reason: court order)', offProcedure: OFF_PROCEDURE_NO_REPL })
  })

  it('keeps clawbacks from another account, of another issuance or with no holder UNRECOGNISED', () => {
    expect(describeProposal(clawbackTx({ account: DESK }), ctx).kind).toBe('unrecognised')
    expect(describeProposal(clawbackTx({ issuance: '0'.repeat(48) }), ctx).kind).toBe('unrecognised')
    expect(describeProposal(clawbackTx({ holder: '' }), ctx).kind).toBe('unrecognised')
    expect(describeProposal(clawbackTx({ holder: REGISTER }), ctx).kind).toBe('unrecognised')
    expect(describeProposal(clawbackTx({ value: '0' }), ctx).kind).toBe('unrecognised')
  })
})

describe('REPLACE on Co-sign: the paired re-issue', () => {
  const withLedger = (actions: ControlAction[], reissues: Reissue[] = []): ProposalContext => ({ ...ctx, replacements: { actions, reissues } })

  it('reads a Register payment to a new wallet as a re-issue when a clawback of the same units carries its reference', () => {
    const paired = clawback('REPL-2026-004', '12500000', 50)
    const preview = describeProposal(reissueTx(), withLedger([paired]))
    expect(preview).toMatchObject({
      kind: 'reissue',
      keySet: 'register',
      destination: NEW,
      replRef: 'REPL-2026-004',
      pairedClawback: paired,
      sentence: 'Re-issue 12,500.000 HQUAY to rLBbnq…gARY · lost-key replacement REPL-2026-004',
      doneSentence: '12,500.000 HQUAY re-issued to rLBbnq…gARY, replacement REPL-2026-004.',
    })
    expect(preview.offProcedure).toBeUndefined()
  })

  it('stays an OFF-PROCEDURE issue until the register ledger is read', () => {
    const preview = describeProposal(reissueTx(), ctx)
    expect(preview).toMatchObject({ kind: 'issue', replRef: 'REPL-2026-004', sentence: 'Issue 12,500.000 HQUAY directly to rLBbnq…gARY', offProcedure: OFF_PROCEDURE_SKIPS_DESK })
  })

  it('stays OFF-PROCEDURE with no clawback for the reference, a different amount, or a clawback already re-issued', () => {
    const none = describeProposal(reissueTx(), withLedger([clawback('REPL-2026-003', '12500000', 50)]))
    expect(none.kind).toBe('issue')
    expect(none.offProcedure).toContain('no claw-back with that reference is on the register ledger')

    const differs = describeProposal(reissueTx({ value: '13000000' }), withLedger([clawback('REPL-2026-004', '12500000', 50)]))
    expect(differs.kind).toBe('issue')
    expect(differs.offProcedure).toBe(
      'it names replacement REPL-2026-004, whose claw-back took 12,500.000 HQUAY, not 13,000.000 HQUAY. A replacement re-issues exactly the clawed-back units.',
    )

    const twice = describeProposal(
      reissueTx({ destination: 'rKm2LxVbT8yQ2kLm6XcW1sZa9Nd3dVaQ', sequence: 20 }),
      withLedger([clawback('REPL-2026-004', '12500000', 50)], [reissue('REPL-2026-004', '12500000', 60, 11)]),
    )
    expect(twice.kind).toBe('issue')
    expect(twice.offProcedure).toBe('replacement REPL-2026-004 was already re-issued to rLBbnq…gARY, so this would put the same units in issue twice.')
  })

  it('still pairs a re-issue the co-signer opens after it landed (its own sequence)', () => {
    const preview = describeProposal(reissueTx({ sequence: 11 }), withLedger([clawback('REPL-2026-004', '12500000', 50)], [reissue('REPL-2026-004', '12500000', 60, 11)]))
    expect(preview.kind).toBe('reissue')
  })

  it('only pairs a clawback of this issuance to a wallet other than the Desk', () => {
    // To the Desk, a REPL memo doesn't make a re-issue: it's an issue without a dealing day.
    const toDesk = describeProposal(reissueTx({ destination: DESK }), withLedger([clawback('REPL-2026-004', '12500000', 50)]))
    expect(toDesk.kind).toBe('issue')
    // Without a REPL memo, a payment to an investor is the Phase 1 skip-the-Desk issue.
    const plain = describeProposal(reissueTx({ memos: [{ type: 'note', data: 'x' }] }), withLedger([clawback('REPL-2026-004', '12500000', 50)]))
    expect(plain).toMatchObject({ kind: 'issue', offProcedure: OFF_PROCEDURE_SKIPS_DESK })
  })
})

describe('telling proposals apart once they land', () => {
  it('compares flags, so a release never reads as its stop-transfer', () => {
    const stop = { Account: REGISTER, Sequence: 9, TransactionType: 'MPTokenIssuanceSet', Holder: LOST, MPTokenIssuanceID: ISSUANCE, Flags: 1 }
    expect(isSameProposal({ ...stop }, stop)).toBe(true)
    expect(isSameProposal({ ...stop, Flags: 2 }, stop)).toBe(false)
    expect(isSameProposal({ ...stop, Flags: 0x80000001 }, stop)).toBe(true)
    // A payment prepared with Flags 0 matches a landed payment without the field.
    const pay = { Account: REGISTER, Sequence: 3, TransactionType: 'Payment', Destination: NEW, Amount: { mpt_issuance_id: ISSUANCE, value: '1' }, Flags: 0 }
    const { Flags: _omitted, ...landed } = pay
    expect(isSameProposal(landed, pay)).toBe(true)
  })
})

describe("the co-signer's holding checks", () => {
  const holding = (balanceRaw: string, locked: boolean, hasHolding = true) => ({ hasHolding, locked, balanceRaw })

  it('blocks controls on an account with no holding, and a clawback from an empty one', () => {
    expect(controlNotice('stop', holding('0', false, false), LOST, 'HQUAY')).toMatchObject({ blocked: true, label: 'No holding' })
    expect(controlNotice('clawback', holding('0', true), LOST, 'HQUAY', '1')).toMatchObject({ blocked: true, label: 'Nothing to claw back' })
  })

  it('notes a stop that changes nothing, a release with nothing to release, and a clawback without a stop', () => {
    expect(controlNotice('stop', holding('5', false), LOST, 'HQUAY')).toBeNull()
    expect(controlNotice('stop', holding('5', true), LOST, 'HQUAY')).toMatchObject({ blocked: false, label: 'Already stopped' })
    expect(controlNotice('release', holding('5', true), LOST, 'HQUAY')).toBeNull()
    expect(controlNotice('release', holding('5', false), LOST, 'HQUAY')).toMatchObject({ blocked: false, label: 'No stop-transfer in place' })
    expect(controlNotice('clawback', holding('12500000', true), LOST, 'HQUAY', '12500000')).toBeNull()
    expect(controlNotice('clawback', holding('12500000', false), LOST, 'HQUAY', '12500000')).toMatchObject({ blocked: false, label: 'No stop-transfer in place' })
    expect(controlNotice('clawback', holding('1000', true), LOST, 'HQUAY', '12500000')).toMatchObject({
      blocked: false,
      label: 'Holds fewer units',
      lines: ['rwwCKT…dMVt holds 1.000 HQUAY, so the claw-back takes only that.'],
    })
  })

  it('words ledger failures for controls in their own terms', () => {
    expect(problemOptionsFor('stop')).toMatchObject({ effect: 'Nothing changed on the register.', meanings: STOP_RESULT_MEANING })
    expect(problemCopy({ status: 'failed', result: 'tecINSUFFICIENT_FUNDS' }, problemOptionsFor('clawback')).detail).toContain(
      CLAWBACK_RESULT_MEANING.tecINSUFFICIENT_FUNDS,
    )
    expect(problemOptionsFor('deliver')).toEqual({})
  })
})
