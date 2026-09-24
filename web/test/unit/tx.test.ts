import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Client, decodeMemo } from 'xrpl'
import { admissionMemo } from '../../src/lib/admission'
import { reasonMemo, replacementMemo } from '../../src/lib/controls'
import { buildAdmissionTx, buildClawbackTx, buildProposalPaymentTx, buildStopTx } from '../../src/lib/tx'

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
        // Autofill keeps the flags a transaction sets (a stop-transfer's tfMPTLock).
        Flags: (tx as { Flags?: unknown }).Flags ?? 0,
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
  it('prepares a stop-transfer and its release: the issuer MPTokenIssuanceSet naming one holder, with the lock flag and a reason memo', async () => {
    const holder = 'rwwCKTRApRm4pWeqGmsNtaKSoooNUxdMVt'
    const stop = await buildStopTx(issuer, holder, issuance, 2, 'lock', reasonMemo('lost key'))
    expect(Client.prototype.autofill).toHaveBeenCalledWith(
      expect.objectContaining({ TransactionType: 'MPTokenIssuanceSet', Account: issuer, Holder: holder, MPTokenIssuanceID: issuance, Flags: 1 }),
      2,
    )
    expect(stop).toMatchObject({ TransactionType: 'MPTokenIssuanceSet', Holder: holder, SigningPubKey: '' })
    expect(stop.LastLedgerSequence).toBeUndefined()
    expect(decodeMemo(stop.Memos![0])).toMatchObject({ type: 'reason', data: 'lost key' })
    await buildStopTx(issuer, holder, issuance, 2, 'unlock', reasonMemo('key found'))
    expect(Client.prototype.autofill).toHaveBeenLastCalledWith(expect.objectContaining({ Holder: holder, Flags: 2 }), 2)
  })
  it('prepares a claw-back of the whole holding with the replacement memo', async () => {
    const holder = 'rwwCKTRApRm4pWeqGmsNtaKSoooNUxdMVt'
    const tx = await buildClawbackTx(issuer, holder, issuance, '12500000', 2, replacementMemo('REPL-2026-004'))
    expect(tx).toMatchObject({
      TransactionType: 'Clawback',
      Account: issuer,
      Holder: holder,
      Amount: { mpt_issuance_id: issuance, value: '12500000' },
      SigningPubKey: '',
    })
    expect(tx.LastLedgerSequence).toBeUndefined()
    expect(decodeMemo(tx.Memos![0])).toMatchObject({ type: 'reason', data: 'REPL-2026-004 · lost key' })
  })
})
