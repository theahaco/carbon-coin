import type { TextMemo } from 'xrpl'
import { KYC_RELIANCE, kycReferenceOf, type Admission } from './admission'
import { pairReplacements, reasonWithoutRef, reissuesOf, replacementRefOf, type ControlAction, type ReplacementPair } from './controls'
import { contractNote, currentDealingDay, formatEuro, isDealingDay } from './dealing'
import { shortAddress } from './format'
import { isFinerThanUnits, issueDeviation, type IssueDeviation } from './procedure'
import { formatAmountExact } from './units'
import type { MptPayment } from './xrplClient'

/**
 * The public register ledger, read-only: every issue, admission,
 * stop-transfer, release and clawback by the Register (the issuer account)
 * and every delivery by the Dealing Desk (the governance account), newest
 * first. A lost-key replacement (the stop, the clawback and the re-issue
 * sharing one `REPL-…` reference) is grouped. Nothing here is enforced by
 * the ledger; it's the public trail that makes a skipped step visible.
 */
export type LedgerStamp = 'ISSUE' | 'ADMIT' | 'DELIVER' | 'REDEEM' | 'STOP' | 'RELEASE' | 'REPLACE' | 'CLAWBACK'

export interface LedgerRow {
  stamp: LedgerStamp
  title: string
  memo: string
  hash?: string
  ledgerIndex?: number
  date?: Date
  /** Set when the entry is valid but doesn't follow the procedure. */
  offProcedure?: string
  /** The lost-key replacement this row belongs to, which groups it. */
  replRef?: string
  /** Which step of that replacement the row is. */
  leg?: 'stop' | 'clawback' | 'reissue'
}

export interface LedgerInput {
  issuerPayments: MptPayment[]
  deskPayments: MptPayment[]
  /** The Register's admissions (RequireAuth issuances only; absent or empty otherwise). */
  admissions?: Admission[]
  /** The Register's stop-transfers, releases and clawbacks (absent when they couldn't be read). */
  controls?: ControlAction[]
  issuer: string
  desk: string
  ticker: string
}

/** The order reference a delivery carries: an `order-ref` memo, else the first text memo's data. */
export function orderRefOf(memos: TextMemo[]): string | undefined {
  return memos.find((memo) => memo.type === 'order-ref' && memo.data)?.data ?? memos.find((memo) => memo.data)?.data
}

/** The dealing day a delivery belongs to: from an `ORD-YYYY-MM-NNN` reference, else the month it was delivered in. */
export function dealingDayOfDelivery(ref: string | undefined, date: Date | undefined): string | undefined {
  const fromRef = ref ? /^ORD-(\d{4}-(?:0[1-9]|1[0-2]))-/.exec(ref)?.[1] : undefined
  return fromRef ?? (date ? currentDealingDay(date) : undefined)
}

/** The investor's line: `Last delivery: order ORD-2026-09-006, dealing day 2026-09.` */
export function lastDeliveryLine(ref: string | undefined, date: Date | undefined): string {
  const day = dealingDayOfDelivery(ref, date)
  const parts = [ref ? `order ${ref}` : '', day ? `dealing day ${day}` : ''].filter(Boolean)
  return parts.length > 0 ? `Last delivery: ${parts.join(', ')}.` : 'Last delivery from the Dealing Desk: details unavailable.'
}

function mintPeriod(memos: TextMemo[]): string | undefined {
  return memos.find((memo) => memo.type === 'mint-period' && memo.data)?.data
}

/** Whether an issue's units are exactly what the dealing day's contract note says. */
export function matchesContractNote(day: string, amountRaw: string): boolean {
  return isDealingDay(day) && contractNote(day).unitsRaw === BigInt(amountRaw)
}

/** The short off-procedure flag for a ledger row: the same issues Co-sign flags, in a few words. */
const LEDGER_REASON: Record<IssueDeviation['kind'], string> = {
  'skips-desk': 'Skipped the Dealing Desk',
  'no-day': 'No dealing-day memo',
  'not-a-month': "Dealing day isn't a YYYY-MM month",
  'finer-than-units': 'More than 3 decimals',
  'units-differ': "Units don't match the contract note",
}

function issueRow(payment: MptPayment, input: LedgerInput): LedgerRow {
  const units = `${formatAmountExact(payment.amountRaw)} ${input.ticker}`
  const day = mintPeriod(payment.memos)
  const toDesk = payment.destination === input.desk
  const replRef = toDesk ? undefined : replacementRefOf(payment.memos)
  // `DD 2026-09` tags a dealing day; the € figures only when the units are the note's. Other labels show as written.
  let memo = day ?? replRef ?? '(no dealing-day memo)'
  if (day && isDealingDay(day)) {
    memo = `DD ${day}`
    if (matchesContractNote(day, payment.amountRaw)) {
      const note = contractNote(day)
      memo += ` · ${formatEuro(note.cash, 0)} ÷ ${formatEuro(note.nav, 4)} (illustrative)`
    }
  }
  const deviation = issueDeviation({ toDesk, day, amountRaw: payment.amountRaw })
  return {
    stamp: 'ISSUE',
    title: toDesk ? `Issued ${units} to the Dealing Desk` : `Issued ${units} directly to ${shortAddress(payment.destination)}`,
    memo,
    hash: payment.hash,
    ledgerIndex: payment.ledgerIndex,
    date: payment.date,
    // Named as a replacement, but no clawback of the same units carries the reference (when the controls could be read).
    offProcedure: replRef && input.controls ? 'No matching claw-back' : deviation && LEDGER_REASON[deviation.kind],
  }
}

function deskRow(payment: MptPayment, input: LedgerInput): LedgerRow {
  const units = `${formatAmountExact(payment.amountRaw)} ${input.ticker}`
  const ref = orderRefOf(payment.memos)
  const base = {
    hash: payment.hash,
    ledgerIndex: payment.ledgerIndex,
    date: payment.date,
    offProcedure: isFinerThanUnits(payment.amountRaw) ? LEDGER_REASON['finer-than-units'] : undefined,
  }
  if (payment.destination === input.issuer) {
    return { ...base, stamp: 'REDEEM', title: `Returned ${units} to the Register for cancellation`, memo: ref ?? '(no memo)' }
  }
  return {
    ...base,
    stamp: 'DELIVER',
    title: `Delivered ${units} to ${shortAddress(payment.destination)}`,
    memo: ref ?? '(no order reference)',
  }
}

/** The ledger memo for an admission: `Desk KYC reliance · ADM-0007`, as the handoff shows it. */
export function admissionMemoLine(memos: TextMemo[]): string | undefined {
  const reference = kycReferenceOf(memos)
  return reference ? `${KYC_RELIANCE} · ${reference}` : undefined
}

function admitRow(admission: Admission, input: LedgerInput): LedgerRow {
  const base = { stamp: 'ADMIT' as const, hash: admission.hash, ledgerIndex: admission.ledgerIndex, date: admission.date }
  const firstText = admission.memos.find((memo) => memo.data)?.data
  // The Dealing Desk is admitted once, at setup, so it can receive issues. It isn't an investor, so it carries no KYC reference.
  if (admission.holder === input.desk) {
    return { ...base, title: 'Admitted the Dealing Desk to the register', memo: firstText ?? '(no memo)' }
  }
  const line = admissionMemoLine(admission.memos)
  return {
    ...base,
    title: `Admitted ${shortAddress(admission.holder)} to the register`,
    memo: line ?? firstText ?? '(no KYC reference)',
    offProcedure: line ? undefined : 'No KYC reference',
  }
}

function controlRow(action: ControlAction, input: LedgerInput, pairedStops: Map<ControlAction, string>): LedgerRow {
  const base = { hash: action.hash, ledgerIndex: action.ledgerIndex, date: action.date }
  const who = shortAddress(action.holder)
  switch (action.kind) {
    case 'stop':
      return {
        ...base,
        stamp: 'STOP',
        title: `Stop-transfer on ${who}`,
        memo: action.reason ? `reason: ${action.reason}` : '(no reason memo)',
        offProcedure: action.reason ? undefined : 'No reason memo',
        ...(pairedStops.has(action) ? { replRef: pairedStops.get(action), leg: 'stop' as const } : {}),
      }
    case 'release':
      return { ...base, stamp: 'RELEASE', title: `Released the stop-transfer on ${who}`, memo: action.reason ? `reason: ${action.reason}` : '(no memo)' }
    case 'clawback': {
      const units = formatAmountExact(action.amountRaw ?? '0')
      if (action.replRef) {
        return { ...base, stamp: 'REPLACE', title: `Clawed back ${units} from ${who}`, memo: action.replRef, replRef: action.replRef, leg: 'clawback' }
      }
      return {
        ...base,
        stamp: 'CLAWBACK',
        title: `Clawed back ${units} ${input.ticker} from ${who}`,
        memo: action.reason ? `reason: ${reasonWithoutRef(action.reason) ?? action.reason}` : '(no reason memo)',
        offProcedure: action.reason ? 'No replacement reference' : 'No reason memo',
      }
    }
  }
}

function reissueRow(payment: MptPayment, pair: ReplacementPair): LedgerRow {
  return {
    stamp: 'REPLACE',
    title: `Re-issued ${formatAmountExact(payment.amountRaw)} to ${shortAddress(payment.destination)}`,
    memo: pair.ref,
    hash: payment.hash,
    ledgerIndex: payment.ledgerIndex,
    date: payment.date,
    replRef: pair.ref,
    leg: 'reissue',
  }
}

/** Every row, newest first. `buildRegisterLedgerEntries` groups a replacement's rows. */
export function buildRegisterLedger(input: LedgerInput): LedgerRow[] {
  const controls = input.controls ?? []
  // A Register payment to a wallet other than the Desk is a re-issue only when a clawback of the same units carries its reference.
  const { pairs } = pairReplacements(controls, reissuesOf(input.issuerPayments, input.desk))
  const reissueOf = new Map<string | number, ReplacementPair>()
  const pairedStops = new Map<ControlAction, string>()
  for (const pair of pairs) {
    if (pair.reissue) reissueOf.set(pair.reissue.hash ?? pair.reissue.ledgerIndex ?? -1, pair)
    if (pair.stop && !pairedStops.has(pair.stop)) pairedStops.set(pair.stop, pair.ref)
  }
  const rows = [
    ...input.issuerPayments.map((p) => {
      const pair = reissueOf.get(p.hash ?? p.ledgerIndex ?? -1)
      return pair ? reissueRow(p, pair) : issueRow(p, input)
    }),
    ...(input.admissions ?? []).map((a) => admitRow(a, input)),
    ...controls.map((c) => controlRow(c, input, pairedStops)),
    ...input.deskPayments.map((p) => deskRow(p, input)),
  ]
  return rows.sort((a, b) => (b.ledgerIndex ?? 0) - (a.ledgerIndex ?? 0))
}

/** One line of the register ledger: a row, or a lost-key replacement's rows in a dashed box. */
export type LedgerEntry =
  | { kind: 'row'; row: LedgerRow }
  | {
      kind: 'group'
      ref: string
      /** `Lost-key replacement · REPL-2026-003`, noting a re-issue that isn't on the ledger yet. */
      label: string
      /** Oldest first: the stop, the clawback, the re-issue. */
      rows: LedgerRow[]
    }

/**
 * The register ledger as the overview shows it: newest first, with each
 * replacement's rows (its stop, clawback and re-issue) grouped under their
 * reference, placed where its newest row falls.
 */
export function groupRegisterLedger(rows: LedgerRow[]): LedgerEntry[] {
  const groups = new Map<string, LedgerRow[]>()
  for (const row of rows) {
    if (!row.replRef) continue
    groups.set(row.replRef, [...(groups.get(row.replRef) ?? []), row])
  }
  const entries: LedgerEntry[] = []
  const placed = new Set<string>()
  for (const row of rows) {
    const ref = row.replRef
    if (!ref) {
      entries.push({ kind: 'row', row })
      continue
    }
    if (placed.has(ref)) continue
    placed.add(ref)
    const members = [...groups.get(ref)!].reverse()
    const reissued = members.some((member) => member.leg === 'reissue')
    entries.push({ kind: 'group', ref, label: `Lost-key replacement · ${ref}${reissued ? '' : ' · re-issue pending'}`, rows: members })
  }
  return entries
}

export function buildRegisterLedgerEntries(input: LedgerInput): LedgerEntry[] {
  return groupRegisterLedger(buildRegisterLedger(input))
}
