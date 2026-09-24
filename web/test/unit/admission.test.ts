import { describe, expect, it } from 'vitest'
import { encodeMemo } from 'xrpl'
import {
  admissionMemo,
  admissionRequestsOf,
  admissionsOf,
  admittedOn,
  investorPicks,
  kycReferenceOf,
  listedAccounts,
  suggestAdmissionRef,
  unadmittedRequests,
} from '../../src/lib/admission'
import { buildRegisterLedger } from '../../src/lib/ledger'
import { issuanceTransactionOf, type IssuanceTransaction } from '../../src/lib/xrplClient'

const ISSUANCE = '014065D7B11826B116E4B189DDE0A405680FEFED641D1DDC'
const REGISTER = 'rH9PYrGRAfLJ3kJCPFrdHLULXf6yQMiw4y'
const DESK = 'rJZLs3cdQnHuf3fJPhC2bo3NghUbG7KWWB'
const INVESTOR = 'rLBbnqV3WCc2C28zhG8BdEr4TRJK8bgARY'
const OTHER = 'rKm2LxVbT8yQ2kLm6XcW1sZa9Nd3dVaQ'

function authorize(account: string, ledgerIndex: number, opts: { holder?: string; flags?: number; memos?: IssuanceTransaction['memos'] } = {}): IssuanceTransaction {
  return {
    type: 'MPTokenAuthorize',
    account,
    holder: opts.holder,
    flags: opts.flags ?? 0,
    memos: opts.memos ?? [],
    ledgerIndex,
    hash: `H${ledgerIndex}`,
    date: new Date(Date.UTC(2026, 8, ledgerIndex)),
  }
}

const kyc = (ref: string) => [admissionMemo(ref)]

describe('reading the issuance history (account_tx, API v1)', () => {
  const row = (tx: Record<string, unknown>, result = 'tesSUCCESS', validated = true) => ({ tx, meta: { TransactionResult: result }, validated })

  it('keeps validated, successful transactions that name the issuance, with memos, date and ledger index', () => {
    const entry = issuanceTransactionOf(
      row({
        TransactionType: 'MPTokenAuthorize',
        Account: REGISTER,
        Holder: INVESTOR,
        MPTokenIssuanceID: ISSUANCE,
        Flags: 0,
        Sequence: 7,
        Memos: [encodeMemo({ type: 'kyc-ref', data: 'ADM-0001 · Desk KYC reliance' })],
        hash: 'ABC',
        ledger_index: 21000000,
        date: 843518670,
      }),
      ISSUANCE,
    )
    expect(entry).toMatchObject({ type: 'MPTokenAuthorize', account: REGISTER, holder: INVESTOR, flags: 0, hash: 'ABC', ledgerIndex: 21000000, sequence: 7 })
    expect(entry?.memos).toEqual([expect.objectContaining({ type: 'kyc-ref', data: 'ADM-0001 · Desk KYC reliance' })])
    // XRPL time 843518670 counts seconds from 2000-01-01 UTC, 946684800 s after the Unix epoch.
    expect(entry?.date?.toISOString()).toBe('2026-09-23T22:44:30.000Z')
  })

  it('keeps MPT payments of the issuance, and drops failed, unvalidated or other-issuance rows', () => {
    expect(issuanceTransactionOf(row({ TransactionType: 'Payment', Account: DESK, Amount: { mpt_issuance_id: ISSUANCE, value: '1' } }), ISSUANCE)?.type).toBe('Payment')
    const admit = { TransactionType: 'MPTokenAuthorize', Account: REGISTER, Holder: INVESTOR, MPTokenIssuanceID: ISSUANCE }
    expect(issuanceTransactionOf(row(admit, 'tecOBJECT_NOT_FOUND'), ISSUANCE)).toBeUndefined()
    expect(issuanceTransactionOf(row(admit, 'tesSUCCESS', false), ISSUANCE)).toBeUndefined()
    expect(issuanceTransactionOf(row({ ...admit, MPTokenIssuanceID: '0'.repeat(48) }), ISSUANCE)).toBeUndefined()
    expect(issuanceTransactionOf(row({ TransactionType: 'AccountSet', Account: REGISTER }), ISSUANCE)).toBeUndefined()
  })
})

describe('admissions and admission requests', () => {
  const history = [
    authorize(DESK, 1),
    authorize(REGISTER, 2, { holder: DESK, memos: [{ type: 'admission', data: 'bootstrap: governance account' }] }),
    authorize(INVESTOR, 3),
    authorize(OTHER, 4),
    authorize(REGISTER, 5, { holder: INVESTOR, memos: kyc('ADM-0007') }),
    // A revocation and a holder's withdrawal are neither admissions nor requests.
    authorize(REGISTER, 6, { holder: OTHER, flags: 1 }),
    authorize(OTHER, 7, { flags: 1 }),
  ]

  it('finds the Register admissions, newest first, ignoring revocations', () => {
    expect(admissionsOf(history, REGISTER).map((a) => [a.holder, a.ledgerIndex])).toEqual([
      [INVESTOR, 5],
      [DESK, 2],
    ])
  })

  it('finds each holder self-authorisation as a request, and which are still unadmitted', () => {
    // OTHER withdrew its request at ledger 7.
    const requests = admissionRequestsOf(history, REGISTER)
    expect(requests.map((r) => r.account)).toEqual([INVESTOR, DESK])
    expect(unadmittedRequests(requests, admissionsOf(history, REGISTER), [DESK]).map((r) => r.account)).toEqual([])
    // Asking again after withdrawing is a new request.
    const again = [...history, authorize(OTHER, 9)]
    expect(unadmittedRequests(admissionRequestsOf(again, REGISTER), admissionsOf(again, REGISTER), [DESK]).map((r) => [r.account, r.ledgerIndex])).toEqual([
      [OTHER, 9],
    ])
  })

  it("dates an investor's admission from the ledger", () => {
    expect(admittedOn(admissionsOf(history, REGISTER), INVESTOR)?.toISOString()).toBe('2026-09-05T00:00:00.000Z')
    expect(admittedOn(admissionsOf(history, REGISTER), OTHER)).toBeUndefined()
  })

  it('reads the KYC reference from the kyc-ref memo, and suggests the next ADM number', () => {
    expect(admissionMemo('ADM-0007')).toEqual({ type: 'kyc-ref', data: 'ADM-0007 · Desk KYC reliance' })
    expect(kycReferenceOf(kyc('ADM-0007'))).toBe('ADM-0007')
    expect(kycReferenceOf([{ type: 'kyc-ref', data: 'DESK/KYC/2026/114' }])).toBe('DESK/KYC/2026/114')
    expect(kycReferenceOf([{ type: 'kyc-ref', data: 'Desk KYC reliance' }])).toBeUndefined()
    expect(kycReferenceOf([{ type: 'note', data: 'ADM-0007' }])).toBeUndefined()
    expect(suggestAdmissionRef(admissionsOf(history, REGISTER))).toBe('ADM-0008')
    expect(suggestAdmissionRef([])).toBe('ADM-0001')
  })
})

describe('ADMIT rows in the register ledger', () => {
  it('shows each admission with its KYC reference, flags one without, and names the Desk bootstrap', () => {
    const admissions = admissionsOf(
      [
        authorize(REGISTER, 2, { holder: DESK, memos: [{ type: 'admission', data: 'bootstrap: governance account' }] }),
        authorize(REGISTER, 5, { holder: INVESTOR, memos: kyc('ADM-0007') }),
        authorize(REGISTER, 8, { holder: OTHER, memos: [{ type: 'note', data: 'friend of the desk' }] }),
      ],
      REGISTER,
    )
    const rows = buildRegisterLedger({ issuer: REGISTER, desk: DESK, ticker: 'HQUAY', issuerPayments: [], deskPayments: [], admissions })
    expect(rows.map((row) => row.stamp)).toEqual(['ADMIT', 'ADMIT', 'ADMIT'])
    expect(rows[0]).toMatchObject({ title: 'Admitted rKm2Lx…dVaQ to the register', memo: 'friend of the desk', offProcedure: 'No KYC reference' })
    expect(rows[1]).toMatchObject({ title: 'Admitted rLBbnq…gARY to the register', memo: 'Desk KYC reliance · ADM-0007', hash: 'H5' })
    expect(rows[1]!.offProcedure).toBeUndefined()
    expect(rows[2]).toMatchObject({ title: 'Admitted the Dealing Desk to the register', memo: 'bootstrap: governance account' })
    expect(rows[2]!.offProcedure).toBeUndefined()
  })

  it('sorts ADMIT rows among issues and deliveries by ledger index', () => {
    const rows = buildRegisterLedger({
      issuer: REGISTER,
      desk: DESK,
      ticker: 'HQUAY',
      issuerPayments: [{ destination: DESK, amountRaw: '235187958000000', ledgerIndex: 10, memos: [{ type: 'mint-period', data: '2026-10' }] }],
      deskPayments: [{ destination: INVESTOR, amountRaw: '25000000000000', ledgerIndex: 12, memos: [{ type: 'order-ref', data: 'ORD-2026-10-014' }] }],
      admissions: admissionsOf([authorize(REGISTER, 11, { holder: INVESTOR, memos: kyc('ADM-0001') })], REGISTER),
    })
    expect(rows.map((row) => row.stamp)).toEqual(['DELIVER', 'ADMIT', 'ISSUE'])
  })
})

describe('Deliver units investor list', () => {
  const now = new Date(2026, 8, 24)
  const delivery = (destination: string, day: number) => ({ destination, amountRaw: '1000', ledgerIndex: day, date: new Date(2026, 8, day), memos: [] })
  const admission = (holder: string, ledgerIndex: number) => ({ holder, memos: [], ledgerIndex })
  const request = (account: string, ledgerIndex: number) => ({ account, ledgerIndex })

  it('lists accounts on the register first, then those awaiting admission, under RequireAuth', () => {
    const picks = investorPicks({
      deliveries: [delivery(INVESTOR, 20), delivery(REGISTER, 19)],
      admissions: [admission(OTHER, 18), admission(INVESTOR, 10), admission(DESK, 2)],
      pending: [request('rwwCKTRApRm4pWeqGmsNtaKSoooNUxdMVt', 21)],
      exclude: [REGISTER, DESK],
      requireAuth: true,
      now,
    })
    expect(picks).toEqual([
      { address: INVESTOR, status: 'Admitted', pending: false, stopped: false },
      { address: OTHER, status: 'Admitted', pending: false, stopped: false },
      { address: 'rwwCKTRApRm4pWeqGmsNtaKSoooNUxdMVt', status: 'Awaiting admission', pending: true, stopped: false },
    ])
  })

  it('keeps the Phase 1 list of past deliveries on an open issuance', () => {
    const picks = investorPicks({
      deliveries: [delivery(INVESTOR, 20), delivery(INVESTOR, 12), delivery(OTHER, 3)],
      admissions: [admission(OTHER, 18)],
      pending: [request('rwwCKTRApRm4pWeqGmsNtaKSoooNUxdMVt', 21)],
      exclude: [REGISTER, DESK],
      requireAuth: false,
      now,
    })
    expect(picks).toEqual([
      { address: INVESTOR, status: 'Last delivery 20 Sep', pending: false, stopped: false },
      { address: OTHER, status: 'Last delivery 03 Sep', pending: false, stopped: false },
    ])
  })

  describe('read against the holdings on the ledger', () => {
    const LOST = 'rEq5ZtThTKd3CtZ6vVotjM1G5JWYFoyHZS'
    const LEFT = 'rab1fzQkLuEuBrDaWuktaFyjve22fye2Rf'
    const REVOKED = 'rMBTDouAfSz2zHGFDhxLqTf35GtvaP5rsS'
    const PENDING = 'rwwCKTRApRm4pWeqGmsNtaKSoooNUxdMVt'
    const admitted = { hasHolding: true, admitted: true, locked: false }
    const input = {
      deliveries: [delivery(INVESTOR, 20), delivery(LOST, 14), delivery(LEFT, 12), delivery(REVOKED, 11)],
      admissions: [admission(OTHER, 18), admission(INVESTOR, 10)],
      pending: [request(PENDING, 21)],
      exclude: [REGISTER, DESK],
      now,
    }

    it('lists the accounts it reads: deliveries, then admissions under RequireAuth, at most five', () => {
      expect(listedAccounts({ ...input, requireAuth: true })).toEqual([INVESTOR, LOST, LEFT, REVOKED, OTHER])
      expect(listedAccounts({ ...input, requireAuth: true }, 2)).toEqual([INVESTOR, LOST])
      expect(listedAccounts({ ...input, requireAuth: false })).toEqual([INVESTOR, LOST, LEFT, REVOKED])
    })

    it('marks a holding under a stop-transfer, drops one with no holding, and moves one no longer admitted to awaiting', () => {
      const holdings = new Map([
        [INVESTOR, admitted],
        // A lost wallet: stopped, then emptied by a replacement. Still stopped, so still marked.
        [LOST, { hasHolding: true, admitted: true, locked: true }],
        [LEFT, { hasHolding: false, admitted: false, locked: false }],
        [REVOKED, { hasHolding: true, admitted: false, locked: false }],
        [OTHER, admitted],
      ])
      expect(investorPicks({ ...input, requireAuth: true, holdings })).toEqual([
        { address: INVESTOR, status: 'Admitted', pending: false, stopped: false },
        { address: LOST, status: 'Stop-transfer in place', pending: false, stopped: true },
        { address: OTHER, status: 'Admitted', pending: false, stopped: false },
        { address: PENDING, status: 'Awaiting admission', pending: true, stopped: false },
        { address: REVOKED, status: 'Awaiting admission', pending: true, stopped: false },
      ])
    })

    it("keeps the history's status for an account whose holding couldn't be read", () => {
      const picks = investorPicks({ ...input, requireAuth: true, holdings: new Map([[LOST, { hasHolding: true, admitted: true, locked: true }]]) })
      expect(picks.map((pick) => [pick.address, pick.status])).toEqual([
        [INVESTOR, 'Admitted'],
        [LOST, 'Stop-transfer in place'],
        [LEFT, 'Admitted'],
        [REVOKED, 'Admitted'],
        [OTHER, 'Admitted'],
        [PENDING, 'Awaiting admission'],
      ])
    })

    it('marks a stop-transfer on an open issuance too, and keeps the rest of the Phase 1 list', () => {
      const holdings = new Map([
        [LOST, { hasHolding: true, admitted: false, locked: true }],
        [LEFT, { hasHolding: false, admitted: false, locked: false }],
      ])
      expect(investorPicks({ ...input, requireAuth: false, holdings }).map((pick) => [pick.address, pick.status, pick.stopped])).toEqual([
        [INVESTOR, 'Last delivery 20 Sep', false],
        [LOST, 'Stop-transfer in place', true],
        [LEFT, 'Last delivery 12 Sep', false],
        [REVOKED, 'Last delivery 11 Sep', false],
      ])
    })
  })
})
