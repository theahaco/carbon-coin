import type { TextMemo } from 'xrpl'
import { formatDate, shortAddress } from './format'
import type { ReadinessNotice } from './readiness'
import { formatUnits } from './units'
import type { IssuanceTransaction, MptHolding } from './xrplClient'

/**
 * Register controls: a per-holder stop-transfer (the issuer's
 * MPTokenIssuanceSet with tfMPTLock and a Holder), its release
 * (tfMPTUnlock), and lost-key replacement, a guided pair of a clawback from
 * the old wallet and a re-issue of the same units to a new, admitted wallet.
 *
 * Every step carries a `reason` memo. Both legs of a replacement share one
 * reference, `REPL-2026-004 · lost key`, which is what pairs them in the
 * register ledger. Nothing on the ledger checks the memos or the pairing:
 * they're the public trail that makes a missing or odd step visible.
 *
 * A stop pauses transfers between holders only. The stopped holder can
 * still return units to the Register, and the Register can still pay it.
 */
export const REASON_MEMO_TYPE = 'reason'
export const LOST_KEY = 'lost key'

/** tfMPTLock and tfMPTUnlock on MPTokenIssuanceSet. */
export const TF_MPT_LOCK = 0x00000001
export const TF_MPT_UNLOCK = 0x00000002

/** tfFullyCanonicalSig: a universal flag that says nothing about what the transaction does. */
const TF_FULLY_CANONICAL_SIG = 0x80000000

const REPL_REF = /\bREPL-(\d{4})-(\d{3,})\b/

export type LockChange = 'lock' | 'unlock'

/**
 * What an MPTokenIssuanceSet's flags do: exactly one of lock or unlock. Any
 * other combination (both, neither, other bits) is undefined.
 */
export function lockChangeOf(flags: unknown): LockChange | undefined {
  let bits: number
  if (flags === undefined) bits = 0
  else if (typeof flags === 'number') bits = (flags & ~TF_FULLY_CANONICAL_SIG) >>> 0
  else if (typeof flags === 'object' && flags !== null) {
    const named = flags as Record<string, unknown>
    if (Object.entries(named).some(([key, on]) => on && key !== 'tfMPTLock' && key !== 'tfMPTUnlock')) return undefined
    bits = (named.tfMPTLock ? TF_MPT_LOCK : 0) | (named.tfMPTUnlock ? TF_MPT_UNLOCK : 0)
  } else return undefined
  if (bits === TF_MPT_LOCK) return 'lock'
  if (bits === TF_MPT_UNLOCK) return 'unlock'
  return undefined
}

/** The reason a control carries: its `reason` memo, else its first text memo. Undefined when there's none. */
export function reasonOf(memos: TextMemo[]): string | undefined {
  const typed = memos.find((memo) => memo.type === REASON_MEMO_TYPE && memo.data?.trim())?.data
  const data = typed ?? memos.find((memo) => memo.data?.trim())?.data
  return data?.trim() || undefined
}

/** The `REPL-YYYY-NNN` reference in a control's memos, if any. */
export function replacementRefOf(memos: TextMemo[]): string | undefined {
  for (const memo of memos) {
    const match = REPL_REF.exec(memo.data ?? '')
    if (match) return match[0]
  }
  return undefined
}

/** The reason without the replacement reference: `REPL-2026-004 · lost key` gives `lost key`. */
export function reasonWithoutRef(reason: string | undefined): string | undefined {
  if (!reason) return undefined
  const rest = reason
    .split(' · ')
    .map((part) => part.trim())
    .filter((part) => part && !REPL_REF.test(part))
    .join(' · ')
  return rest || undefined
}

export function reasonMemo(reason: string): TextMemo {
  return { type: REASON_MEMO_TYPE, data: reason.trim() }
}

/** The memo both legs of a replacement carry: `{ type: 'reason', data: 'REPL-2026-004 · lost key' }`. */
export function replacementMemo(ref: string): TextMemo {
  return reasonMemo(`${ref} · ${LOST_KEY}`)
}

/** The next `REPL-YYYY-NNN` for this year: one past the highest in these memos, `-001` when there's none. */
export function suggestReplacementRef(memoSets: TextMemo[][], now: Date = new Date()): string {
  const year = now.getFullYear()
  let highest = 0
  for (const memos of memoSets) {
    for (const memo of memos) {
      const match = REPL_REF.exec(memo.data ?? '')
      if (match && Number(match[1]) === year) highest = Math.max(highest, Number(match[2]))
    }
  }
  return `REPL-${year}-${String(highest + 1).padStart(3, '0')}`
}

export interface ControlAction {
  kind: 'stop' | 'release' | 'clawback'
  holder: string
  memos: TextMemo[]
  reason?: string
  replRef?: string
  /** What a clawback actually took, raw. */
  amountRaw?: string
  hash?: string
  ledgerIndex?: number
  sequence?: number
  date?: Date
}

function newestFirst<T extends { ledgerIndex?: number }>(items: T[]): T[] {
  return [...items].sort((a, b) => (b.ledgerIndex ?? 0) - (a.ledgerIndex ?? 0))
}

function oldestFirst<T extends { ledgerIndex?: number }>(items: T[]): T[] {
  return [...items].sort((a, b) => (a.ledgerIndex ?? 0) - (b.ledgerIndex ?? 0))
}

/**
 * The Register's stop-transfers, releases and clawbacks on single holdings,
 * newest first. A lock or unlock without a Holder (the whole class, a
 * dealing suspension) isn't a control this app runs, so it's left out.
 */
export function controlActionsOf(transactions: IssuanceTransaction[], issuer: string): ControlAction[] {
  const actions: ControlAction[] = []
  for (const tx of transactions) {
    if (tx.account !== issuer || !tx.holder || tx.holder === issuer) continue
    const base = {
      holder: tx.holder,
      memos: tx.memos,
      reason: reasonOf(tx.memos),
      replRef: replacementRefOf(tx.memos),
      hash: tx.hash,
      ledgerIndex: tx.ledgerIndex,
      sequence: tx.sequence,
      date: tx.date,
    }
    if (tx.type === 'MPTokenIssuanceSet') {
      const change = lockChangeOf(tx.flags)
      if (change) actions.push({ ...base, kind: change === 'lock' ? 'stop' : 'release' })
    } else if (tx.type === 'Clawback' && tx.amountRaw !== undefined) {
      actions.push({ ...base, kind: 'clawback', amountRaw: tx.amountRaw })
    }
  }
  return newestFirst(actions)
}

/** A Register payment to a wallet other than the Dealing Desk that names a replacement: a candidate re-issue. */
export interface Reissue {
  destination: string
  amountRaw: string
  replRef: string
  hash?: string
  ledgerIndex?: number
  sequence?: number
  date?: Date
}

/** Register payments (`destination`, `amountRaw`, memos) that name a `REPL-…` reference and don't go to the Desk. */
export function reissuesOf(
  payments: Array<{ destination?: string; amountRaw?: string; memos: TextMemo[]; hash?: string; ledgerIndex?: number; sequence?: number; date?: Date }>,
  desk: string,
): Reissue[] {
  return payments.flatMap((payment) => {
    const replRef = replacementRefOf(payment.memos)
    if (!replRef || !payment.destination || payment.destination === desk || payment.amountRaw === undefined) return []
    return [
      {
        destination: payment.destination,
        amountRaw: payment.amountRaw,
        replRef,
        hash: payment.hash,
        ledgerIndex: payment.ledgerIndex,
        sequence: payment.sequence,
        date: payment.date,
      },
    ]
  })
}

export interface ReplacementPair {
  ref: string
  clawback: ControlAction
  /** The re-issue of the same units under the same reference, once it's on the ledger. */
  reissue?: Reissue
  /** The stop-transfer on the old wallet that preceded the clawback, if the ledger shows one still in place. */
  stop?: ControlAction
}

/**
 * Pairs each re-issue with the earliest earlier clawback carrying the same
 * reference and the same units that no other re-issue has taken. A re-issue
 * with no such clawback stays unmatched: new units straight to a wallet.
 */
export function pairReplacements(actions: ControlAction[], reissues: Reissue[]): { pairs: ReplacementPair[]; unmatched: Reissue[] } {
  const pairs: ReplacementPair[] = oldestFirst(actions.filter((a) => a.kind === 'clawback' && a.replRef)).map((clawback) => ({
    ref: clawback.replRef!,
    clawback,
    stop: stopBefore(actions, clawback),
  }))
  const unmatched: Reissue[] = []
  for (const reissue of oldestFirst(reissues)) {
    const pair = pairs.find(
      (p) =>
        !p.reissue &&
        p.ref === reissue.replRef &&
        p.clawback.amountRaw === reissue.amountRaw &&
        (p.clawback.ledgerIndex ?? 0) <= (reissue.ledgerIndex ?? Number.MAX_SAFE_INTEGER),
    )
    if (pair) pair.reissue = reissue
    else unmatched.push(reissue)
  }
  return { pairs, unmatched }
}

/** The stop-transfer in place on the clawback's holder when it happened: its latest stop, unless a release came after. */
function stopBefore(actions: ControlAction[], clawback: ControlAction): ControlAction | undefined {
  const at = clawback.ledgerIndex ?? Number.MAX_SAFE_INTEGER
  const latest = newestFirst(actions).find(
    (a) => a.holder === clawback.holder && (a.kind === 'stop' || a.kind === 'release') && (a.ledgerIndex ?? 0) <= at,
  )
  return latest?.kind === 'stop' ? latest : undefined
}

/**
 * The replacement a given clawback started: matched on the clawback itself
 * (the Register's sequence, or its hash), never on the reference alone,
 * which an earlier replacement may share.
 */
export function replacementOfClawback(pairs: ReplacementPair[], clawback: { sequence?: number; hash?: string }): ReplacementPair | undefined {
  return pairs.find(
    (pair) =>
      (clawback.sequence !== undefined && pair.clawback.sequence === clawback.sequence) ||
      (clawback.hash !== undefined && pair.clawback.hash === clawback.hash),
  )
}

/** Replacements whose clawback is on the ledger but whose re-issue isn't yet, oldest first. */
export function unfinishedReplacements(pairs: ReplacementPair[]): ReplacementPair[] {
  return pairs.filter((pair) => !pair.reissue)
}

/** The reason on a holder's latest stop-transfer, if its latest control is a stop. */
export function currentStop(actions: ControlAction[], holder: string): ControlAction | undefined {
  const latest = newestFirst(actions).find((a) => a.holder === holder && (a.kind === 'stop' || a.kind === 'release'))
  return latest?.kind === 'stop' ? latest : undefined
}

/**
 * What a stopped holder's own account card says: that transfers are
 * paused and, when the Register has clawed units back from the holding
 * since the stop, what it took. It makes no promise about the units: the
 * Register can claw them back.
 */
export function stoppedHoldingNote(actions: ControlAction[], holder: string, ticker: string): string {
  const since = currentStop(actions, holder)?.ledgerIndex ?? 0
  const clawback = newestFirst(actions).find((a) => a.kind === 'clawback' && a.holder === holder && (a.ledgerIndex ?? 0) >= since)
  if (!clawback) return 'Transfers paused on this holding while the register reviews it.'
  const took = `${formatUnits(clawback.amountRaw ?? '0')} ${ticker}`
  const when = clawback.date ? ` on ${formatDate(clawback.date)}` : ''
  const why = clawback.replRef ? ` for lost-key replacement ${clawback.replRef}` : ''
  return `The Register clawed back ${took} from this holding${when}${why}. Transfers stay paused on it.`
}

/**
 * How a proposed re-issue (a Register payment to a wallet other than the
 * Desk, naming `ref`) stands against the register ledger:
 * - `paired`: a clawback with the same reference took exactly these units,
 *   and no re-issue has used it yet. The procedure.
 * - `no-clawback`: no clawback carries the reference.
 * - `amount-differs`: the reference's clawback took different units.
 * - `already-reissued`: the reference's clawback is already paired.
 * `sequence` leaves this very proposal out, if it's already on the ledger.
 */
export type ReissueMatch =
  | { status: 'paired'; pair: ReplacementPair }
  | { status: 'no-clawback' }
  | { status: 'amount-differs'; pair: ReplacementPair }
  | { status: 'already-reissued'; pair: ReplacementPair }

export function matchReissue(
  proposal: { ref: string; amountRaw: string; sequence?: number },
  actions: ControlAction[],
  reissues: Reissue[],
): ReissueMatch {
  const others = reissues.filter((reissue) => proposal.sequence === undefined || reissue.sequence !== proposal.sequence)
  const withRef = pairReplacements(actions, others).pairs.filter((pair) => pair.ref === proposal.ref)
  if (withRef.length === 0) return { status: 'no-clawback' }
  const sameUnits = withRef.filter((pair) => pair.clawback.amountRaw === proposal.amountRaw)
  const open = sameUnits.find((pair) => !pair.reissue)
  if (open) return { status: 'paired', pair: open }
  if (sameUnits[0]) return { status: 'already-reissued', pair: sameUnits[0] }
  return { status: 'amount-differs', pair: withRef[0]! }
}

/**
 * The co-signer's check on a stop-transfer, release or clawback against
 * the holding as it stands: GhostSig submits at quorum without a
 * preflight, so one the ledger would reject still spends its fee. Blocked
 * notices mean the ledger would reject it; the others change nothing or
 * skip a step. Null when it's as the procedure expects.
 */
export function controlNotice(
  kind: 'stop' | 'release' | 'clawback',
  holding: Pick<MptHolding, 'hasHolding' | 'locked' | 'balanceRaw'>,
  holder: string,
  ticker: string,
  amountRaw?: string,
): ReadinessNotice | null {
  const who = shortAddress(holder)
  if (!holding.hasHolding) {
    return { blocked: true, label: 'No holding', lines: [`${who} has no ${ticker} holding on the ledger, so the ledger would reject this.`] }
  }
  if (kind === 'stop') {
    return holding.locked
      ? { blocked: false, label: 'Already stopped', lines: [`${who} already has a stop-transfer in place. Signing this again changes nothing.`] }
      : null
  }
  if (kind === 'release') {
    return holding.locked
      ? null
      : { blocked: false, label: 'No stop-transfer in place', lines: [`${who} has no stop-transfer to release. Signing this changes nothing.`] }
  }
  const balance = BigInt(holding.balanceRaw)
  if (balance === 0n) {
    return { blocked: true, label: 'Nothing to claw back', lines: [`${who} holds no units, so the ledger would reject the claw-back.`] }
  }
  const lines: string[] = []
  if (!holding.locked) lines.push(`${who} has no stop-transfer in place. A lost-key replacement starts by stopping transfers on the old wallet.`)
  if (amountRaw !== undefined && BigInt(amountRaw) > balance) {
    lines.push(`${who} holds ${formatUnits(balance)} ${ticker}, so the claw-back takes only that.`)
  }
  if (lines.length === 0) return null
  return { blocked: false, label: holding.locked ? 'Holds fewer units' : 'No stop-transfer in place', lines }
}
