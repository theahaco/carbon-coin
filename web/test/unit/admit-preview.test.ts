import { describe, expect, it } from 'vitest'
import { encodeMemo } from 'xrpl'
import { admissionMemo, admissionNotice, admissionState } from '../../src/lib/admission'
import { ADMISSION_RESULT_MEANING, problemCopy } from '../../src/lib/outcome'
import { describeProposal, OFF_PROCEDURE_NO_KYC } from '../../src/lib/preview'
import { isSameProposal } from '../../src/lib/xrplClient'

const ISSUANCE = '014065D7B11826B116E4B189DDE0A405680FEFED641D1DDC'
const REGISTER = 'rH9PYrGRAfLJ3kJCPFrdHLULXf6yQMiw4y'
const DESK = 'rJZLs3cdQnHuf3fJPhC2bo3NghUbG7KWWB'
const INVESTOR = 'rwwCKTRApRm4pWeqGmsNtaKSoooNUxdMVt'
const ctx = { ticker: 'HQUAY', mptIssuanceId: ISSUANCE, issuer: REGISTER, desk: DESK }

function admit(opts: { account?: string; holder?: string; issuance?: string; flags?: unknown; memos?: Array<{ type: string; data: string }> } = {}) {
  return {
    TransactionType: 'MPTokenAuthorize',
    Account: opts.account ?? REGISTER,
    MPTokenIssuanceID: opts.issuance ?? ISSUANCE,
    ...(opts.holder === '' ? {} : { Holder: opts.holder ?? INVESTOR }),
    Flags: opts.flags ?? 0,
    Fee: '36',
    Sequence: 5,
    SigningPubKey: '',
    ...(opts.memos ? { Memos: opts.memos.map((m) => encodeMemo(m)) } : {}),
  }
}

describe('ADMIT on Co-sign', () => {
  it('reads a Register admission with a KYC reference as the handoff words it', () => {
    const preview = describeProposal(admit({ memos: [admissionMemo('ADM-0007')] }), ctx)
    expect(preview).toMatchObject({
      kind: 'admit',
      keySet: 'register',
      holder: INVESTOR,
      kycRef: 'ADM-0007',
      sentence: 'Admit rwwCKT…dMVt to the register',
      relay: 'Admit rwwCKT…dMVt to the register (KYC by the Dealing Desk, reliance agreement)',
      doneSentence: 'rwwCKT…dMVt admitted to the register.',
    })
    expect(preview.offProcedure).toBeUndefined()
    expect(preview.rawFields).toContainEqual(['Holder', INVESTOR])
  })

  it('flags an admission whose memo carries no KYC reference as OFF-PROCEDURE, still signable', () => {
    for (const memos of [undefined, [{ type: 'note', data: 'ADM-0007' }], [{ type: 'kyc-ref', data: 'Desk KYC reliance' }]]) {
      const preview = describeProposal(admit({ memos }), ctx)
      expect(preview.kind).toBe('admit')
      expect(preview.keySet).toBe('register')
      expect(preview.offProcedure).toBe(OFF_PROCEDURE_NO_KYC)
      // No KYC claim in the relay when there's no reference.
      expect(preview.relay).toBeUndefined()
    }
    expect(OFF_PROCEDURE_NO_KYC).toBe('the memo carries no Dealing Desk KYC reference.')
  })

  it("reads the Desk's own admission without asking for a KYC reference", () => {
    const preview = describeProposal(admit({ holder: DESK, memos: [{ type: 'admission', data: 'bootstrap: governance account' }] }), ctx)
    expect(preview).toMatchObject({ kind: 'admit', sentence: 'Admit the Dealing Desk to the register' })
    expect(preview.offProcedure).toBeUndefined()
  })

  it('keeps every other MPTokenAuthorize UNRECOGNISED: another sender or issuance, no holder, a revocation', () => {
    expect(describeProposal(admit({ account: DESK }), ctx).kind).toBe('unrecognised')
    expect(describeProposal(admit({ account: INVESTOR, holder: '' }), ctx).kind).toBe('unrecognised')
    expect(describeProposal(admit({ issuance: '0'.repeat(48) }), ctx).kind).toBe('unrecognised')
    expect(describeProposal(admit({ holder: '' }), ctx).kind).toBe('unrecognised')
    expect(describeProposal(admit({ holder: REGISTER }), ctx).kind).toBe('unrecognised')
    expect(describeProposal(admit({ flags: 1 }), ctx).kind).toBe('unrecognised')
    expect(describeProposal(admit({ flags: { tfMPTUnauthorize: true } }), ctx).kind).toBe('unrecognised')
  })

  it('keeps other unknown types UNRECOGNISED', () => {
    for (const TransactionType of ['MPTokenIssuanceSet', 'Clawback', 'AccountSet', 'SignerListSet']) {
      expect(describeProposal({ ...admit(), TransactionType }, ctx).kind).toBe('unrecognised')
    }
  })
})

describe('admission checks before signing', () => {
  it('is ready only for a requested, unadmitted account on a RequireAuth issuance', () => {
    expect(admissionState({ hasHolding: true, admitted: false }, true)).toBe('ready')
    expect(admissionState({ hasHolding: false, admitted: false }, true)).toBe('no-holding')
    expect(admissionState({ hasHolding: true, admitted: true }, true)).toBe('already-admitted')
    expect(admissionState({ hasHolding: true, admitted: false }, false)).toBe('not-required')
    expect(admissionNotice('ready', INVESTOR, 'HQUAY')).toBeNull()
    expect(admissionNotice('no-holding', INVESTOR, 'HQUAY')).toMatchObject({ blocked: true, label: 'No admission request' })
    expect(admissionNotice('already-admitted', INVESTOR, 'HQUAY')?.lines[0]).toBe('rwwCKT…dMVt is already admitted. Admitting it again changes nothing.')
  })

  it('words a failed admission for the register, not as units that moved', () => {
    const copy = problemCopy(
      { status: 'failed', result: 'tecOBJECT_NOT_FOUND' },
      { effect: 'Nothing changed on the register.', meanings: ADMISSION_RESULT_MEANING },
    )
    expect(copy.headline).toBe('The XRPL testnet rejected it (tecOBJECT_NOT_FOUND). Nothing changed on the register.')
    expect(copy.detail).toMatch(/hasn't requested admission/)
  })

  it('recognises a landed admission as the same proposal, and a different holder as another', () => {
    const proposal = admit({ memos: [admissionMemo('ADM-0007')] })
    expect(isSameProposal({ ...proposal, hash: 'H' }, proposal)).toBe(true)
    expect(isSameProposal({ ...proposal, Holder: DESK }, proposal)).toBe(false)
    expect(isSameProposal({ ...proposal, MPTokenIssuanceID: '0'.repeat(48) }, proposal)).toBe(false)
  })
})
