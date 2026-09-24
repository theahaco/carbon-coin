import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Client, decodeMemo } from 'xrpl'
import { admissionMemo } from '../../src/lib/admission'
import { buildAdmissionTx, buildProposalPaymentTx } from '../../src/lib/tx'

const issuer = 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh'
const governance = 'rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe'
const issuance = '0'.repeat(48)

beforeEach(() => {
  vi.spyOn(Client.prototype, 'connect').mockResolvedValue()
  vi.spyOn(Client.prototype, 'autofill').mockImplementation(
    async (tx) =>
      ({
        ...tx,
        Fee: '36',
        Sequence: 42,
        LastLedgerSequence: 100,
        Flags: 0,
      }) as never,
  )
})
afterEach(() => vi.restoreAllMocks())

describe('GhostSig proposal preparation', () => {
  it('hands off one prepared multisig payload with explicit unbounded expiry', async () => {
    const tx = await buildProposalPaymentTx(issuer, governance, issuance, '100', 2)
    expect(tx).toMatchObject({
      Account: issuer,
      TransactionType: 'Payment',
      Sequence: 42,
      Fee: '36',
      SigningPubKey: '',
    })
    expect(tx.LastLedgerSequence).toBeUndefined()
    expect(tx.Signers).toBeUndefined()
    expect(Client.prototype.autofill).toHaveBeenCalledWith(expect.objectContaining({ Account: issuer }), 2)
  })
  it('includes the UTF-8 memo in the prepared payload', async () => {
    const tx = await buildProposalPaymentTx(issuer, governance, issuance, '100', 2, {
      type: 'mint-period',
      data: '2027',
    })
    expect(decodeMemo(tx.Memos![0])).toMatchObject({ type: 'mint-period', data: '2027' })
  })
  it('prepares a Register admission: the issuer MPTokenAuthorize naming the holder, with its KYC memo', async () => {
    const holder = 'rwwCKTRApRm4pWeqGmsNtaKSoooNUxdMVt'
    const tx = await buildAdmissionTx(issuer, holder, issuance, 2, admissionMemo('ADM-0001'))
    expect(tx).toMatchObject({
      Account: issuer,
      TransactionType: 'MPTokenAuthorize',
      MPTokenIssuanceID: issuance,
      Holder: holder,
      Sequence: 42,
      SigningPubKey: '',
    })
    expect(tx.LastLedgerSequence).toBeUndefined()
    expect(decodeMemo(tx.Memos![0])).toMatchObject({ type: 'kyc-ref', data: 'ADM-0001 · Desk KYC reliance' })
    expect(Client.prototype.autofill).toHaveBeenCalledWith(expect.objectContaining({ Account: issuer, Holder: holder }), 2)
  })
})
