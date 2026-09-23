import { decodeMemo, type Memo } from 'xrpl'
import { brand, type KeySet } from '../brand'
import { contractNote, noteShortForm, type ContractNote } from './dealing'
import { shortAddress } from './format'
import { orderRefOf } from './ledger'
import { isFinerThanUnits, issueDeviation, type IssueDeviation } from './procedure'
import { formatAmountExact, formatUnits } from './units'

/**
 * Plain-language description of a proposal, decoded from the transaction
 * itself -- never from a proposer's free text. The same sentence is the
 * relay message, the co-sign preview and the result line.
 *
 * A proposal is one of the procedures this demo runs, or UNRECOGNISED:
 * - issue: a Register (issuer) Payment of this issuance to the Dealing Desk,
 *   carrying the dealing day. Anything else from the Register is flagged
 *   OFF-PROCEDURE (still signable; the ledger doesn't forbid it).
 * - deliver: a Dealing Desk (governance) Payment of this issuance to an
 *   investor, carrying the order reference.
 * - return: a Dealing Desk Payment back to the Register, which cancels the
 *   units (the redemption leg).
 * - unrecognised: any other transaction type, source account, asset or
 *   malformed amount. The sign button is hidden for these.
 */
export type ProposalKind = 'issue' | 'deliver' | 'return' | 'unrecognised'

export interface ProposalContext {
  ticker: string
  mptIssuanceId?: string
  /** The Register (issuer) account. */
  issuer?: string
  /** The Dealing Desk (governance) account. */
  desk?: string
}

export interface ProposalPreview {
  kind: ProposalKind
  /** Which key set must sign. Undefined for unrecognised proposals. */
  keySet?: KeySet
  /** "Issue 235,187.958 HQUAY to the Dealing Desk for dealing day 2026-10 (€2,450,000 ÷ NAV €10.4172)", "Deliver 25,000.000 HQUAY to rAb7Tq…Q7Kx · order ORD-2026-10-014" */
  sentence: string
  /** The past-tense result line, once quorum is met. */
  doneSentence: string
  /** Completes "The transaction is valid, but {reason} Check with the proposer before you sign." */
  offProcedure?: string
  /** The contract note, when the issue's units match it exactly. */
  note?: ContractNote
  day?: string
  orderRef?: string
  account: string
  destination?: string
  amountRaw?: string
  /** Every top-level field, for the record. */
  rawFields: Array<[string, string]>
}

export const OFF_PROCEDURE_SKIPS_DESK =
  'the units go straight to an investor and skip the Dealing Desk. Register issues normally go only to the Desk.'

export const FINER_THAN_UNITS = 'its amount has more than 3 decimals, and units are only ever dealt in thousandths.'

/** Completes "The transaction is valid, but {reason} Check with the proposer before you sign." */
function coSignReason(deviation: IssueDeviation, ticker: string): string {
  switch (deviation.kind) {
    case 'skips-desk':
      return OFF_PROCEDURE_SKIPS_DESK
    case 'no-day':
      return 'it carries no dealing-day memo, so it belongs to no dealing day.'
    case 'not-a-month':
      return `its dealing day "${deviation.day}" isn't a YYYY-MM month.`
    case 'finer-than-units':
      return FINER_THAN_UNITS
    case 'units-differ':
      return `the units don't match the contract note for dealing day ${deviation.day} (${formatUnits(deviation.note.unitsRaw)} ${ticker} at ${noteShortForm(deviation.note)}, illustrative).`
  }
}

function textMemos(tx: Record<string, unknown>) {
  const memos = Array.isArray(tx.Memos) ? (tx.Memos as Memo[]) : []
  return memos.flatMap((memo) => {
    try {
      return memo?.Memo ? [decodeMemo(memo)] : []
    } catch {
      return []
    }
  })
}

function rawValue(key: string, value: unknown): string {
  if (key === 'Flags' && typeof value === 'number') return `0x${value.toString(16).toUpperCase().padStart(8, '0')}`
  if (key === 'Signers' && Array.isArray(value)) return `${value.length} signature${value.length === 1 ? '' : 's'}`
  if (key === 'Memos' && Array.isArray(value)) {
    const decoded = textMemos({ Memos: value })
    return decoded.length > 0 ? decoded.map((m) => `${m.type ?? '(no type)'}: ${m.data ?? ''}`).join('; ') : `${value.length} binary memo(s)`
  }
  if (typeof value === 'object' && value !== null) return JSON.stringify(value)
  return String(value)
}

/** Every top-level field as display strings, signature material summarised. */
export function rawFieldsOf(tx: Record<string, unknown>): Array<[string, string]> {
  return Object.entries(tx)
    .filter(([key, value]) => key !== 'TxnSignature' && !(key === 'SigningPubKey' && value === ''))
    .map(([key, value]) => [key, rawValue(key, value)])
}

function unrecognised(tx: Record<string, unknown>): ProposalPreview {
  return {
    kind: 'unrecognised',
    sentence: `This transaction doesn't match any ${brand.name} procedure.`,
    doneSentence: 'Submitted.',
    account: String(tx.Account ?? ''),
    destination: typeof tx.Destination === 'string' ? tx.Destination : undefined,
    rawFields: rawFieldsOf(tx),
  }
}

export function describeProposal(tx: Record<string, unknown>, ctx: ProposalContext): ProposalPreview {
  const account = typeof tx.Account === 'string' ? tx.Account : ''
  const destination = typeof tx.Destination === 'string' ? tx.Destination : ''
  const amount = tx.Amount as { mpt_issuance_id?: unknown; value?: unknown } | string | undefined
  const fromRegister = Boolean(ctx.issuer) && account === ctx.issuer
  const fromDesk = Boolean(ctx.desk) && account === ctx.desk

  if (tx.TransactionType !== 'Payment' || (!fromRegister && !fromDesk)) return unrecognised(tx)
  if (typeof amount !== 'object' || amount === null || typeof amount.value !== 'string' || !/^[1-9]\d*$/.test(amount.value)) {
    return unrecognised(tx)
  }
  if (!ctx.mptIssuanceId || amount.mpt_issuance_id !== ctx.mptIssuanceId) return unrecognised(tx)
  if (!destination || destination === account) return unrecognised(tx)

  const amountRaw = amount.value
  // A single payment's amount is never floored here: /sign is the check on any blob.
  const units = `${formatAmountExact(amountRaw)} ${ctx.ticker}`
  const memos = textMemos(tx)
  const base = { account, destination, amountRaw, rawFields: rawFieldsOf(tx) }

  if (fromRegister) {
    const day = memos.find((memo) => memo.type === 'mint-period' && memo.data)?.data
    const deviation = issueDeviation({ toDesk: destination === ctx.desk, day, amountRaw })
    const issue = { ...base, kind: 'issue' as const, keySet: 'register' as const, day }
    if (deviation?.kind === 'skips-desk') {
      return {
        ...issue,
        sentence: `Issue ${units} directly to ${shortAddress(destination)}`,
        doneSentence: `${units} issued to ${shortAddress(destination)}.`,
        offProcedure: coSignReason(deviation, ctx.ticker),
      }
    }
    if (!day) {
      return {
        ...issue,
        sentence: `Issue ${units} to the Dealing Desk`,
        doneSentence: `${units} issued to the Dealing Desk.`,
        offProcedure: deviation && coSignReason(deviation, ctx.ticker),
      }
    }
    const done = `${units} issued to the Dealing Desk for dealing day ${day}.`
    if (deviation) {
      return {
        ...issue,
        sentence: `Issue ${units} to the Dealing Desk for dealing day ${day}`,
        doneSentence: done,
        offProcedure: coSignReason(deviation, ctx.ticker),
      }
    }
    const note = contractNote(day)
    return {
      ...issue,
      note,
      sentence: `Issue ${units} to the Dealing Desk for dealing day ${day} (${noteShortForm(note)})`,
      doneSentence: done,
    }
  }

  // From the Dealing Desk.
  if (destination === ctx.issuer) {
    return {
      ...base,
      kind: 'return',
      keySet: 'desk',
      sentence: `Return ${units} to the Register for cancellation`,
      doneSentence: `${units} returned to the Register for cancellation.`,
      offProcedure: isFinerThanUnits(amountRaw) ? FINER_THAN_UNITS : undefined,
    }
  }
  const orderRef = orderRefOf(memos)
  return {
    ...base,
    kind: 'deliver',
    keySet: 'desk',
    orderRef,
    // The relay and co-sign line use a middle dot; the past-tense result keeps the comma, as in the handoff.
    sentence: `Deliver ${units} to ${shortAddress(destination)}${orderRef ? ` · order ${orderRef}` : ' · no order reference'}`,
    doneSentence: `${units} delivered to ${shortAddress(destination)}${orderRef ? `, order ${orderRef}` : ''}.`,
    offProcedure: isFinerThanUnits(amountRaw) ? FINER_THAN_UNITS : undefined,
  }
}
