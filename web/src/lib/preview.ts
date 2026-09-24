import { decodeMemo, type Memo } from 'xrpl'
import { brand, type KeySet } from '../brand'
import { kycReferenceOf } from './admission'
import { lockChangeOf, matchReissue, reasonOf, replacementRefOf, type ControlAction, type Reissue, type ReissueMatch } from './controls'
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
 * - admit: a Register MPTokenAuthorize naming a holder, which admits that
 *   account to the register (RequireAuth). Flagged OFF-PROCEDURE when its
 *   memo carries no Dealing Desk KYC reference.
 * - stop / release: a Register MPTokenIssuanceSet naming a holder, with
 *   tfMPTLock (stop-transfer) or tfMPTUnlock (release). A stop is flagged
 *   OFF-PROCEDURE when it carries no reason memo.
 * - clawback: a Register Clawback of this issuance from a holder, the first
 *   leg of a lost-key replacement. Flagged OFF-PROCEDURE without a
 *   `REPL-YYYY-NNN` reference.
 * - reissue: a Register Payment to a wallet other than the Desk whose
 *   `REPL-…` memo matches a clawback of the same units with the same
 *   reference on the register ledger (`ctx.replacements`), the second leg.
 *   Anything else to a wallet other than the Desk is an OFF-PROCEDURE issue.
 * - unrecognised: any other transaction type, source account, asset or
 *   malformed amount, a revocation (tfMPTUnauthorize), or a lock or unlock
 *   of the whole class (a dealing suspension is never proposed here). The
 *   sign button is hidden for these.
 */
export type ProposalKind = 'issue' | 'deliver' | 'return' | 'admit' | 'stop' | 'release' | 'clawback' | 'reissue' | 'unrecognised'

export interface ProposalContext {
  ticker: string
  mptIssuanceId?: string
  /** The Register (issuer) account. */
  issuer?: string
  /** The Dealing Desk (governance) account. */
  desk?: string
  /**
   * The register ledger's controls and candidate re-issues, which a proposed
   * re-issue is matched against. Until they're read, a Register payment to
   * a wallet other than the Desk stays an OFF-PROCEDURE issue.
   */
  replacements?: { actions: ControlAction[]; reissues: Reissue[] }
}

export interface ProposalPreview {
  kind: ProposalKind
  /** Which key set must sign. Undefined for unrecognised proposals. */
  keySet?: KeySet
  /** "Issue 235,187.958 HQUAY to the Dealing Desk for dealing day 2026-10 (€2,450,000 ÷ NAV €10.4172)", "Deliver 25,000.000 HQUAY to rAb7Tq…Q7Kx · order ORD-2026-10-014", "Admit rHn4Vb…m2Pc to the register", "Stop-transfer on rPz9Ce…8wLe (reason: lost key)" */
  sentence: string
  /** The relay message, when it says more than `sentence` (an admission names the KYC reliance). */
  relay?: string
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
  /** The account an admission, stop-transfer, release or clawback names. */
  holder?: string
  /** The Dealing Desk KYC reference an admission's memo carries. */
  kycRef?: string
  /** A control's reason memo. */
  reason?: string
  /** The lost-key replacement reference (`REPL-2026-004`) a clawback or re-issue carries. */
  replRef?: string
  /** For a re-issue: the clawback on the register ledger it pairs with. */
  pairedClawback?: ControlAction
  amountRaw?: string
  /** Every top-level field, for the record. An unrecognised one also lists a missing Holder or Memos as `(none)`. */
  rawFields: Array<[string, string]>
}

export const OFF_PROCEDURE_SKIPS_DESK =
  'the units go straight to an investor and skip the Dealing Desk. Register issues normally go only to the Desk.'

export const FINER_THAN_UNITS = 'its amount has more than 3 decimals, and units are only ever dealt in thousandths.'

export const OFF_PROCEDURE_NO_KYC = 'the memo carries no Dealing Desk KYC reference.'

export const OFF_PROCEDURE_NO_REASON = 'there is no reason memo.'

export const OFF_PROCEDURE_NO_REPL =
  'its memo carries no REPL replacement reference. Claw-backs here are the first half of a lost-key replacement.'

/** MPTokenIssuanceSet fields that change the issuance itself (DynamicMPT): never part of a stop-transfer. */
const ISSUANCE_MUTATIONS = ['MPTokenMetadata', 'TransferFee', 'MutableFlags', 'DomainID']

/** `tfMPTUnauthorize` on MPTokenAuthorize: from the issuer, it revokes an admission. */
const TF_MPT_UNAUTHORIZE = 0x00000001

function revokes(flags: unknown): boolean {
  if (typeof flags === 'number') return (flags & TF_MPT_UNAUTHORIZE) !== 0
  return typeof flags === 'object' && flags !== null && Boolean((flags as { tfMPTUnauthorize?: unknown }).tfMPTUnauthorize)
}

/**
 * A Register admission: the issuer's MPTokenAuthorize for this issuance,
 * naming the account it admits as `Holder`. Anything else of that type
 * (another account, issuance or a revocation) is unrecognised.
 */
function describeAdmission(tx: Record<string, unknown>, ctx: ProposalContext): ProposalPreview {
  const account = typeof tx.Account === 'string' ? tx.Account : ''
  const holder = typeof tx.Holder === 'string' ? tx.Holder : ''
  if (!ctx.issuer || account !== ctx.issuer) return unrecognised(tx)
  if (!ctx.mptIssuanceId || tx.MPTokenIssuanceID !== ctx.mptIssuanceId) return unrecognised(tx)
  if (!holder || holder === account || revokes(tx.Flags)) return unrecognised(tx)
  const base = { kind: 'admit' as const, keySet: 'register' as const, account, holder, rawFields: rawFieldsOf(tx) }
  // The Dealing Desk is admitted once, at setup; it isn't an investor, so no KYC reference is expected.
  if (holder === ctx.desk) {
    return { ...base, sentence: 'Admit the Dealing Desk to the register', doneSentence: 'The Dealing Desk admitted to the register.' }
  }
  const who = shortAddress(holder)
  const kycRef = kycReferenceOf(textMemos(tx))
  return {
    ...base,
    kycRef,
    sentence: `Admit ${who} to the register`,
    relay: kycRef ? `Admit ${who} to the register (KYC by the Dealing Desk, reliance agreement)` : undefined,
    doneSentence: `${who} admitted to the register.`,
    offProcedure: kycRef ? undefined : OFF_PROCEDURE_NO_KYC,
  }
}

/**
 * A Register stop-transfer or release: the issuer's MPTokenIssuanceSet for
 * this issuance naming one holder, with exactly tfMPTLock or tfMPTUnlock.
 * Without a holder it would lock or unlock the whole class, which is a
 * dealing suspension and never proposed here: unrecognised.
 */
function describeLockChange(tx: Record<string, unknown>, ctx: ProposalContext): ProposalPreview {
  const account = typeof tx.Account === 'string' ? tx.Account : ''
  const holder = typeof tx.Holder === 'string' ? tx.Holder : ''
  if (!ctx.issuer || account !== ctx.issuer) return unrecognised(tx)
  if (!ctx.mptIssuanceId || tx.MPTokenIssuanceID !== ctx.mptIssuanceId) return unrecognised(tx)
  if (!holder || holder === account || ISSUANCE_MUTATIONS.some((field) => tx[field] !== undefined)) return unrecognised(tx)
  const change = lockChangeOf(tx.Flags)
  if (!change) return unrecognised(tx)
  const who = shortAddress(holder)
  const reason = reasonOf(textMemos(tx))
  const because = reason ? ` (reason: ${reason})` : ''
  const base = { keySet: 'register' as const, account, holder, reason, rawFields: rawFieldsOf(tx) }
  if (change === 'lock') {
    return {
      ...base,
      kind: 'stop',
      sentence: `Stop-transfer on ${who}${because}`,
      doneSentence: `Stop-transfer in place on ${who}.`,
      offProcedure: reason ? undefined : OFF_PROCEDURE_NO_REASON,
    }
  }
  return {
    ...base,
    kind: 'release',
    sentence: `Release the stop-transfer on ${who}${because}`,
    doneSentence: `Stop-transfer released on ${who}.`,
  }
}

/** A positive whole raw amount of this issuance, or undefined. */
function issuanceAmountOf(amount: unknown, ctx: ProposalContext): string | undefined {
  const mpt = amount as { mpt_issuance_id?: unknown; value?: unknown } | undefined
  if (typeof amount !== 'object' || amount === null || typeof mpt?.value !== 'string' || !/^[1-9]\d*$/.test(mpt.value)) return undefined
  if (!ctx.mptIssuanceId || mpt.mpt_issuance_id !== ctx.mptIssuanceId) return undefined
  return mpt.value
}

/** A Register clawback from one holder: the first leg of a lost-key replacement when it carries a `REPL-…` reference. */
function describeClawback(tx: Record<string, unknown>, ctx: ProposalContext): ProposalPreview {
  const account = typeof tx.Account === 'string' ? tx.Account : ''
  const holder = typeof tx.Holder === 'string' ? tx.Holder : ''
  const amountRaw = issuanceAmountOf(tx.Amount, ctx)
  if (!ctx.issuer || account !== ctx.issuer || !holder || holder === account || !amountRaw) return unrecognised(tx)
  const units = `${formatAmountExact(amountRaw)} ${ctx.ticker}`
  const who = shortAddress(holder)
  const memos = textMemos(tx)
  const reason = reasonOf(memos)
  const replRef = replacementRefOf(memos)
  const base = { kind: 'clawback' as const, keySet: 'register' as const, account, holder, amountRaw, reason, replRef, rawFields: rawFieldsOf(tx) }
  if (replRef) {
    return {
      ...base,
      sentence: `Claw back ${units} from ${who} · lost-key replacement ${replRef}`,
      doneSentence: `${units} clawed back from ${who}, replacement ${replRef}.`,
      offProcedure: isFinerThanUnits(amountRaw) ? FINER_THAN_UNITS : undefined,
    }
  }
  return {
    ...base,
    sentence: `Claw back ${units} from ${who}${reason ? ` (reason: ${reason})` : ''}`,
    doneSentence: `${units} clawed back from ${who}.`,
    offProcedure: reason ? OFF_PROCEDURE_NO_REPL : OFF_PROCEDURE_NO_REASON,
  }
}

/** Completes the OFF-PROCEDURE sentence for a payment naming a replacement that the register ledger doesn't pair. */
function unpairedReason(match: ReissueMatch | undefined, ref: string, units: string, ticker: string): string {
  switch (match?.status) {
    case undefined:
      return OFF_PROCEDURE_SKIPS_DESK
    case 'no-clawback':
      return `it names replacement ${ref}, and no claw-back with that reference is on the register ledger. Without one, it issues new units straight to an investor, skipping the Dealing Desk.`
    case 'amount-differs':
      return `it names replacement ${ref}, whose claw-back took ${formatAmountExact(match.pair.clawback.amountRaw ?? '0')} ${ticker}, not ${units}. A replacement re-issues exactly the clawed-back units.`
    case 'already-reissued': {
      const earlier = match.pair.reissue
      const to = earlier ? ` to ${shortAddress(earlier.destination)}` : ''
      return `replacement ${ref} was already re-issued${to}, so this would put the same units in issue twice.`
    }
    case 'paired':
      return ''
  }
}

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

/** Transaction types where a missing `Holder` changes what they do: without one, an MPTokenIssuanceSet locks the whole class. */
const HOLDER_TYPES = ['MPTokenIssuanceSet', 'MPTokenAuthorize', 'Clawback']

/** The raw record of an unrecognised transaction, naming the fields it leaves out that decide what it does. */
function unrecognisedFieldsOf(tx: Record<string, unknown>): Array<[string, string]> {
  const absent: Array<[string, string]> = []
  if (typeof tx.TransactionType === 'string' && HOLDER_TYPES.includes(tx.TransactionType) && tx.Holder === undefined) absent.push(['Holder', '(none)'])
  if (tx.Memos === undefined) absent.push(['Memos', '(none)'])
  return [...rawFieldsOf(tx), ...absent]
}

function unrecognised(tx: Record<string, unknown>): ProposalPreview {
  return {
    kind: 'unrecognised',
    sentence: `This transaction doesn't match any ${brand.name} procedure.`,
    doneSentence: 'Submitted.',
    account: String(tx.Account ?? ''),
    destination: typeof tx.Destination === 'string' ? tx.Destination : undefined,
    rawFields: unrecognisedFieldsOf(tx),
  }
}

export function describeProposal(tx: Record<string, unknown>, ctx: ProposalContext): ProposalPreview {
  const account = typeof tx.Account === 'string' ? tx.Account : ''
  const destination = typeof tx.Destination === 'string' ? tx.Destination : ''
  const amount = tx.Amount as { mpt_issuance_id?: unknown; value?: unknown } | string | undefined
  const fromRegister = Boolean(ctx.issuer) && account === ctx.issuer
  const fromDesk = Boolean(ctx.desk) && account === ctx.desk

  if (tx.TransactionType === 'MPTokenAuthorize') return describeAdmission(tx, ctx)
  if (tx.TransactionType === 'MPTokenIssuanceSet') return describeLockChange(tx, ctx)
  if (tx.TransactionType === 'Clawback') return describeClawback(tx, ctx)
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
    const replRef = destination === ctx.desk ? undefined : replacementRefOf(memos)
    const match = replRef && ctx.replacements
      ? matchReissue({ ref: replRef, amountRaw, sequence: typeof tx.Sequence === 'number' ? tx.Sequence : undefined }, ctx.replacements.actions, ctx.replacements.reissues)
      : undefined
    if (replRef && match?.status === 'paired') {
      const who = shortAddress(destination)
      return {
        ...base,
        kind: 'reissue',
        keySet: 'register',
        replRef,
        reason: reasonOf(memos),
        pairedClawback: match.pair.clawback,
        sentence: `Re-issue ${units} to ${who} · lost-key replacement ${replRef}`,
        doneSentence: `${units} re-issued to ${who}, replacement ${replRef}.`,
        offProcedure: isFinerThanUnits(amountRaw) ? FINER_THAN_UNITS : undefined,
      }
    }
    if (deviation?.kind === 'skips-desk') {
      return {
        ...issue,
        replRef,
        sentence: `Issue ${units} directly to ${shortAddress(destination)}`,
        doneSentence: `${units} issued to ${shortAddress(destination)}.`,
        offProcedure: replRef ? unpairedReason(match, replRef, units, ctx.ticker) : coSignReason(deviation, ctx.ticker),
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
