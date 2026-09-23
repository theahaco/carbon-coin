import { contractNote, isDealingDay, sameDealingDay, type ContractNote } from './dealing'
import { isWholeThousandths } from './units'
import type { MintRecord } from './xrplClient'

/**
 * Units are only ever dealt in whole thousandths (3 decimals). A payment of
 * the issuance that's finer than that came from outside this app's
 * procedures, whoever sends it.
 */
export function isFinerThanUnits(amountRaw: string): boolean {
  return !isWholeThousandths(amountRaw)
}

/**
 * How a Register issue departs from the dealing-day procedure (issue to the
 * Dealing Desk, carrying a `YYYY-MM` dealing day, for exactly the contract
 * note's units). One classifier, so Co-sign and the register ledger flag
 * the same issues; each surface words the reason its own way.
 */
export type IssueDeviation =
  | { kind: 'skips-desk' }
  | { kind: 'no-day' }
  | { kind: 'not-a-month'; day: string }
  | { kind: 'finer-than-units' }
  | { kind: 'units-differ'; day: string; note: ContractNote }

export interface IssueFacts {
  /** Whether the destination is the Dealing Desk. */
  toDesk: boolean
  /** The dealing-day memo, if any. */
  day?: string
  amountRaw: string
}

/** The first way this issue departs from the procedure, or undefined when it follows it. */
export function issueDeviation({ toDesk, day, amountRaw }: IssueFacts): IssueDeviation | undefined {
  if (!toDesk) return { kind: 'skips-desk' }
  if (!day) return { kind: 'no-day' }
  if (!isDealingDay(day)) return { kind: 'not-a-month', day }
  if (!isWholeThousandths(amountRaw)) return { kind: 'finer-than-units' }
  const note = contractNote(day)
  if (note.unitsRaw !== BigInt(amountRaw)) return { kind: 'units-differ', day, note }
  return undefined
}

/**
 * The issue already on the ledger for `day`, if any, other than the
 * transaction with `sequence` (a co-signer may open a proposal that has
 * since been submitted).
 */
export function alreadyIssued(records: MintRecord[], day: string, sequence?: unknown): MintRecord | undefined {
  return records.find((record) => sameDealingDay(record.period, day) && (sequence === undefined || record.sequence !== sequence))
}
