import type { ProposalStatus } from './xrplClient'

/** A proposal that settled without going through: failed on the ledger, superseded, or unreadable. */
export type ProblemStatus = Extract<ProposalStatus, { status: 'failed' | 'superseded' | 'unknown' }>

export function isProblem(status: ProposalStatus): status is ProblemStatus {
  return status.status === 'failed' || status.status === 'superseded' || status.status === 'unknown'
}

/** What a `tec` result code means, where it's specific enough to say. */
const RESULT_MEANING: Record<string, string> = {
  tecLOCKED: 'the issuance or one of the holdings is locked: dealing is suspended, or a stop-transfer is in place.',
  tecNO_AUTH: "the destination isn't authorised to hold these units.",
  tecINSUFFICIENT_FUNDS: "the sending account didn't hold enough to cover it.",
  tecPATH_PARTIAL: "the full amount couldn't be delivered; the sending account may not hold enough units.",
  tecPATH_DRY: "the full amount couldn't be delivered; the sending account may not hold enough units.",
  tecNO_DST: "the destination account doesn't exist on the testnet.",
}

/** What a `tec` result means for an admission, where it differs from a payment. */
export const ADMISSION_RESULT_MEANING: Record<string, string> = {
  tecOBJECT_NOT_FOUND: "the account had no holding to admit: it hasn't requested admission, or it withdrew the request.",
  tecNO_AUTH: "the issuance doesn't set RequireAuth, so there's no admission to give.",
  tecNO_DST: "the account doesn't exist on the testnet.",
}

export interface ProblemOptions {
  /** What didn't happen, after the result code. Payments: 'No units moved.' */
  effect?: string
  /** Result meanings that override the payment ones. */
  meanings?: Record<string, string>
}

export interface ProblemCopy {
  label: string
  headline: string
  detail: string
}

/** Plain-language copy for a proposal that didn't go through. */
export function problemCopy(status: ProblemStatus, opts: ProblemOptions = {}): ProblemCopy {
  if (status.status === 'failed') {
    const meaning = opts.meanings?.[status.result] ?? RESULT_MEANING[status.result]
    return {
      label: 'Failed on the ledger',
      headline: `The XRPL testnet rejected it (${status.result}). ${opts.effect ?? 'No units moved.'}`,
      detail: `${meaning ? `The ledger's reason: ${meaning} ` : ''}Its sequence is now spent, so this proposal can't be submitted again. Fix the cause, then propose it afresh.`,
    }
  }
  if (status.status === 'superseded') {
    return {
      label: "Didn't go through",
      headline: "Another transaction used this proposal's sequence.",
      detail: "So this proposal can't be submitted any more. Check the register ledger, then propose again if it's still needed.",
    }
  }
  return {
    label: "Couldn't confirm",
    headline: "This proposal's sequence has been used, but the transaction that used it couldn't be read.",
    detail: 'Check the register ledger to see whether it went through before proposing it again.',
  }
}
