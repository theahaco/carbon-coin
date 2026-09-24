import { encodeMemo, type TextMemo } from 'xrpl'
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
