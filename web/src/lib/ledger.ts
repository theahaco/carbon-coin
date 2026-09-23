import type { TextMemo } from 'xrpl'
import { contractNote, currentDealingDay, formatEuro, isDealingDay } from './dealing'
import { shortAddress } from './format'
import { isFinerThanUnits, issueDeviation, type IssueDeviation } from './procedure'
import { formatAmountExact } from './units'
import type { MptPayment } from './xrplClient'

/**
 * The public register ledger, read-only: every issue by the Register (the
 * issuer account) and every delivery by the Dealing Desk (the governance
 * account), newest first. Nothing here is enforced by the ledger; it's the
 * public trail that makes a skipped step visible.
 */
export type LedgerStamp = 'ISSUE' | 'DELIVER' | 'REDEEM'

export interface LedgerRow {
  stamp: LedgerStamp
  title: string
  memo: string
  hash?: string
  ledgerIndex?: number
  date?: Date
  /** Set when the entry is valid but doesn't follow the procedure. */
  offProcedure?: string
}

export interface LedgerInput {
  issuerPayments: MptPayment[]
  deskPayments: MptPayment[]
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
  // `DD 2026-09` tags a dealing day; the € figures only when the units are the note's. Other labels show as written.
  let memo = day ?? '(no dealing-day memo)'
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
    offProcedure: deviation && LEDGER_REASON[deviation.kind],
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

export function buildRegisterLedger(input: LedgerInput): LedgerRow[] {
  const rows = [...input.issuerPayments.map((p) => issueRow(p, input)), ...input.deskPayments.map((p) => deskRow(p, input))]
  return rows.sort((a, b) => (b.ledgerIndex ?? 0) - (a.ledgerIndex ?? 0))
}
