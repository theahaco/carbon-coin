import { MPTokenIssuanceSetFlags, encodeMemo, type TextMemo } from 'xrpl'
import type { LockChange } from './controls'
import { getClient } from './xrplClient'

/**
 * The demo's equal-weight signer lists need `quorum` signatures. Weighted signer
 * lists must instead budget the actual signature count. GhostSig collects and
 * submits the signatures; the SDK prepares the payload once before handoff.
 * An explicit unbounded ceremony remains valid until its sequence is consumed.
 */
export async function buildProposalPaymentTx(
  fromAddress: string,
  toAddress: string,
  mptIssuanceId: string,
  valueRaw: string,
  signersCount: number,
  memo?: TextMemo,
) {
  const client = await getClient()
  const proposal = await client
    .forAccount(fromAddress)
    .tx.payment({
      Destination: toAddress,
      Amount: { mpt_issuance_id: mptIssuanceId, value: valueRaw },
      ...(memo ? { Memos: [encodeMemo(memo)] } : {}),
    })
    .prepareMultisig({ signersCount, expiry: 'none' })
  return { ...proposal.toJSON() }
}

/**
 * The Register's admission of `holder` under RequireAuth: the issuer's
 * MPTokenAuthorize naming the account as Holder, with its KYC memo.
 * Prepared once for GhostSig, exactly like a payment proposal.
 */
export async function buildAdmissionTx(issuerAddress: string, holder: string, mptIssuanceId: string, signersCount: number, memo: TextMemo) {
  const client = await getClient()
  const proposal = await client
    .forAccount(issuerAddress)
    .tx.mpTokenAuthorize({ MPTokenIssuanceID: mptIssuanceId, Holder: holder, Memos: [encodeMemo(memo)] })
    .prepareMultisig({ signersCount, expiry: 'none' })
  return { ...proposal.toJSON() }
}

/**
 * The Register's stop-transfer on one holding (`lock`), or its release: the
 * issuer's MPTokenIssuanceSet naming the holder, with tfMPTLock or
 * tfMPTUnlock and a reason memo. Never a lock of the whole class.
 */
export async function buildStopTx(
  issuerAddress: string,
  holder: string,
  mptIssuanceId: string,
  signersCount: number,
  change: LockChange,
  memo: TextMemo,
) {
  const client = await getClient()
  const proposal = await client
    .forAccount(issuerAddress)
    .tx.mpTokenIssuanceSet({
      MPTokenIssuanceID: mptIssuanceId,
      Holder: holder,
      Flags: change === 'lock' ? MPTokenIssuanceSetFlags.tfMPTLock : MPTokenIssuanceSetFlags.tfMPTUnlock,
      Memos: [encodeMemo(memo)],
    })
    .prepareMultisig({ signersCount, expiry: 'none' })
  return { ...proposal.toJSON() }
}

/** The Register's clawback of `valueRaw` units from `holder`, with its reason memo (a replacement's `REPL-…` reference). */
export async function buildClawbackTx(
  issuerAddress: string,
  holder: string,
  mptIssuanceId: string,
  valueRaw: string,
  signersCount: number,
  memo: TextMemo,
) {
  const client = await getClient()
  const proposal = await client
    .forAccount(issuerAddress)
    .tx.clawback({ Holder: holder, Amount: { mpt_issuance_id: mptIssuanceId, value: valueRaw }, Memos: [encodeMemo(memo)] })
    .prepareMultisig({ signersCount, expiry: 'none' })
  return { ...proposal.toJSON() }
}
