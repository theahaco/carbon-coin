import {
  Client,
  RippledError,
  decodeMemo,
  fetchMPTokenIssuanceOrUndefined,
  fetchMPTokenOrUndefined,
  parseAccountRootFlags,
  parseMPTokenFlags,
  parseMPTokenIssuanceFlags,
  rippleTimeToUnixTime,
  type MPTokenIssuanceFlagsInterface,
  type TextMemo,
} from 'xrpl'
import { admissionRequestsOf, admissionsOf, unadmittedRequests, type AdmissionRequest } from './admission'
import { suggestNextDealingDay } from './dealing'
import { LOCK_CHECK, describeReadiness, type LockSides, type ReadinessNotice } from './readiness'

// GHOSTSIG only understands XRPL testnet/devnet/mainnet, so this demo is
// pinned to the public Testnet -- the same network `XRPL_NETWORK=testnet`
// selects for the CLI scripts.
const TESTNET_WS_URL = 'wss://s.altnet.rippletest.net:51233'
export const TESTNET_EXPLORER_BASE = 'https://testnet.xrpl.org'

let clientPromise: Promise<Client> | undefined

/** A single shared, lazily-connected Client for the lifetime of the page. */
export async function getClient(): Promise<Client> {
  if (!clientPromise) {
    clientPromise = (async () => {
      const client = new Client(TESTNET_WS_URL)
      await client.connect()
      return client
    })().catch((err) => {
      clientPromise = undefined
      throw err
    })
  }
  return clientPromise
}

export async function getOutstandingSupplyRaw(mptIssuanceId: string): Promise<string> {
  const client = await getClient()
  const res = await client.command.ledgerEntry({ mpt_issuance: mptIssuanceId })
  return res.result.node.OutstandingAmount
}

export interface MptHolding {
  /** The account has an MPToken for this issuance: it self-authorised (asked to hold units). */
  hasHolding: boolean
  /** The issuer admitted it (`lsfMPTAuthorized`). Only meaningful when the issuance sets RequireAuth. */
  admitted: boolean
  balanceRaw: string
  locked: boolean
}

/** Read confirmed holdings. A missing entry is distinct from a failed network read. */
export async function getMptHolding(address: string, mptIssuanceId: string): Promise<MptHolding> {
  const client = await getClient()
  const token = await fetchMPTokenOrUndefined(client, address, mptIssuanceId, 'validated')
  const flags = token ? parseMPTokenFlags(token.Flags) : undefined
  return {
    hasHolding: token !== undefined,
    admitted: Boolean(flags?.lsfMPTAuthorized),
    balanceRaw: token?.MPTAmount ?? '0',
    locked: Boolean(flags?.lsfMPTLocked),
  }
}

/**
 * Advisory checks for this transfer, in plain copy (null when every check
 * passed). Pass `amount` to check the sender's balance too. Failed reads
 * throw, so they stay visible as errors rather than passing.
 */
export async function checkTransfer(
  account: string,
  destination: string,
  mptIssuanceId: string,
  opts: { source: string; amount?: string; requireAuth?: boolean },
): Promise<ReadinessNotice | null> {
  const client = await getClient()
  const readiness = await client.getMptTransferReadiness({ account, destination, mptIssuanceId, amount: opts.amount })
  // The SDK's lock check doesn't say what's locked. Read it at the same ledger; if that fails, the copy names both possibilities.
  const locks = readiness.checks.some((check) => check.message === LOCK_CHECK && check.status !== 'pass')
    ? await readLocks(client, account, destination, mptIssuanceId, readiness.ledgerIndex).catch(() => undefined)
    : undefined
  return describeReadiness(readiness, { destination, source: opts.source, requireAuth: opts.requireAuth, locks })
}

/** Which of the issuance and the two holdings carry lsfMPTLocked at `ledgerIndex`. */
async function readLocks(client: Client, account: string, destination: string, mptIssuanceId: string, ledgerIndex: number): Promise<LockSides> {
  const [issuance, source, target] = await Promise.all([
    fetchMPTokenIssuanceOrUndefined(client, mptIssuanceId, ledgerIndex),
    fetchMPTokenOrUndefined(client, account, mptIssuanceId, ledgerIndex),
    fetchMPTokenOrUndefined(client, destination, mptIssuanceId, ledgerIndex),
  ])
  return {
    issuance: Boolean(issuance && parseMPTokenIssuanceFlags(issuance.Flags).lsfMPTLocked),
    source: Boolean(source && parseMPTokenFlags(source.Flags).lsfMPTLocked),
    destination: Boolean(target && parseMPTokenFlags(target.Flags).lsfMPTLocked),
  }
}

/** Returns the account's XRP balance in drops, or `undefined` if it isn't funded/activated yet. */
export async function getXrpBalanceDrops(address: string): Promise<string | undefined> {
  const client = await getClient()
  try {
    const res = await client.command.accountInfo({ account: address })
    return res.result.account_data.Balance
  } catch (error) {
    if (error instanceof RippledError && error.code === 'actNotFound') return undefined
    throw error
  }
}

export async function isAccountFunded(address: string): Promise<boolean> {
  return (await getXrpBalanceDrops(address)) !== undefined
}

/** The issuance's live state: units in issue and its flags (including the lock that suspends dealing). */
export interface IssuanceState {
  outstandingRaw: string
  flags: MPTokenIssuanceFlagsInterface
}

export async function getIssuanceState(mptIssuanceId: string): Promise<IssuanceState> {
  const client = await getClient()
  const res = await client.command.ledgerEntry({ mpt_issuance: mptIssuanceId })
  const node = res.result.node as { OutstandingAmount?: string; Flags?: number }
  return { outstandingRaw: node.OutstandingAmount ?? '0', flags: parseMPTokenIssuanceFlags(node.Flags ?? 0) }
}

/**
 * Whether the issuance sets RequireAuth, so every holder needs the
 * Register's admission. Read from the ledger; if that read fails, from the
 * flags deployment.json published, else false (the open Phase 1 issuance).
 */
export async function getRequireAuth(mptIssuanceId: string, publishedFlag: boolean | undefined): Promise<boolean> {
  try {
    return Boolean((await getIssuanceState(mptIssuanceId)).flags.lsfMPTRequireAuth)
  } catch {
    return publishedFlag ?? false
  }
}

/** Whether the account's master key is disabled (so only its signer list can sign for it). */
export async function isMasterKeyDisabled(address: string): Promise<boolean> {
  const client = await getClient()
  const res = await client.command.accountInfo({ account: address })
  return Boolean(parseAccountRootFlags(res.result.account_data.Flags).lsfDisableMaster)
}

/** One validated, successful outgoing payment of the issuance, with its text memos decoded. */
export interface MptPayment {
  destination: string
  /** Delivered amount, raw ledger units. */
  amountRaw: string
  hash?: string
  ledgerIndex?: number
  sequence?: number
  date?: Date
  /** Memos that decode as UTF-8 text; binary memos are skipped. */
  memos: TextMemo[]
}

function textMemos(memos: ReadonlyArray<Parameters<typeof decodeMemo>[0]> | undefined): TextMemo[] {
  const decoded: TextMemo[] = []
  for (const memo of memos ?? []) {
    try {
      decoded.push(decodeMemo(memo))
    } catch {
      /* Binary or malformed memos carry no text. */
    }
  }
  return decoded
}

/** Every available page of `account`'s outgoing payments of this issuance whose delivered amount is known. */
export async function getOutgoingMptPayments(account: string, mptIssuanceId: string): Promise<MptPayment[]> {
  const client = await getClient()
  const { payments } = await client.getMptPaymentHistory(account, mptIssuanceId)
  return payments.flatMap(({ transaction, deliveredAmount, hash, ledgerIndex }) => {
    if (deliveredAmount === undefined) return []
    // API v1 history rows carry the close time and the ledger index on the
    // transaction itself; the SDK's record-level `ledgerIndex` stays undefined
    // for them, so fall back to the transaction's.
    const v1 = transaction as { date?: unknown; ledger_index?: unknown }
    const closeTime = v1.date
    const index = typeof ledgerIndex === 'number' ? ledgerIndex : typeof v1.ledger_index === 'number' ? v1.ledger_index : undefined
    return [
      {
        destination: String(transaction.Destination ?? ''),
        amountRaw: deliveredAmount,
        hash,
        ledgerIndex: index,
        sequence: typeof transaction.Sequence === 'number' ? transaction.Sequence : undefined,
        date: typeof closeTime === 'number' ? new Date(rippleTimeToUnixTime(closeTime)) : undefined,
        memos: textMemos(transaction.Memos),
      },
    ]
  })
}

/**
 * One validated, successful transaction that names this issuance (in
 * `MPTokenIssuanceID` or an MPT `Amount`), from an account's history, with
 * its text memos decoded. The issuer's history carries more than its own
 * transactions: the ledger also files every holder's MPToken change there,
 * so a holder's self-authorisation (an admission request) shows up too.
 */
export interface IssuanceTransaction {
  type: string
  account: string
  holder?: string
  /** A payment's destination. */
  destination?: string
  /**
   * The units that moved, raw: a payment's delivered amount, or what a
   * clawback actually took (the ledger claws at most the holder's balance).
   */
  amountRaw?: string
  flags: number
  memos: TextMemo[]
  hash?: string
  ledgerIndex?: number
  sequence?: number
  date?: Date
}

interface MetaNode {
  ModifiedNode?: {
    LedgerEntryType?: unknown
    FinalFields?: { OutstandingAmount?: unknown }
    PreviousFields?: { OutstandingAmount?: unknown }
  }
}

/**
 * How far a transaction lowered the issuance's units in issue, from its
 * metadata: what a clawback actually took. Undefined when the metadata
 * doesn't show the issuance.
 */
function issuanceDecreaseOf(meta: { AffectedNodes?: unknown }): string | undefined {
  const nodes = Array.isArray(meta.AffectedNodes) ? (meta.AffectedNodes as MetaNode[]) : []
  const node = nodes.find((n) => n.ModifiedNode?.LedgerEntryType === 'MPTokenIssuance')?.ModifiedNode
  if (!node) return undefined
  const previous = node.PreviousFields?.OutstandingAmount
  // Unchanged fields aren't in PreviousFields; a zero amount is left out of FinalFields.
  if (typeof previous !== 'string') return '0'
  const final = typeof node.FinalFields?.OutstandingAmount === 'string' ? node.FinalFields.OutstandingAmount : '0'
  return (BigInt(previous) - BigInt(final)).toString()
}

function mptValueOf(amount: unknown): string | undefined {
  const value = (amount as { value?: unknown } | undefined)?.value
  return typeof amount === 'object' && amount !== null && typeof value === 'string' ? value : undefined
}

/** Reads one API v1 `account_tx` row. Undefined unless it's validated, succeeded and names this issuance. */
export function issuanceTransactionOf(
  row: { tx?: unknown; meta?: unknown; validated?: unknown },
  mptIssuanceId: string,
): IssuanceTransaction | undefined {
  const tx = row.tx as Record<string, unknown> | undefined
  const meta = row.meta as { TransactionResult?: unknown; AffectedNodes?: unknown; delivered_amount?: unknown } | string | undefined
  if (row.validated !== true || !tx || typeof meta !== 'object' || meta.TransactionResult !== 'tesSUCCESS') return undefined
  const amount = tx.Amount as { mpt_issuance_id?: unknown } | string | undefined
  const namesIssuance =
    tx.MPTokenIssuanceID === mptIssuanceId || (typeof amount === 'object' && amount !== null && amount.mpt_issuance_id === mptIssuanceId)
  if (!namesIssuance || typeof tx.TransactionType !== 'string' || typeof tx.Account !== 'string') return undefined
  const amountRaw =
    tx.TransactionType === 'Clawback'
      ? (issuanceDecreaseOf(meta) ?? mptValueOf(amount))
      : tx.TransactionType === 'Payment'
        ? (mptValueOf(meta.delivered_amount) ?? mptValueOf(amount))
        : undefined
  return {
    type: tx.TransactionType,
    account: tx.Account,
    holder: typeof tx.Holder === 'string' ? tx.Holder : undefined,
    destination: typeof tx.Destination === 'string' ? tx.Destination : undefined,
    amountRaw,
    flags: typeof tx.Flags === 'number' ? tx.Flags : 0,
    memos: textMemos(tx.Memos as Parameters<typeof textMemos>[0]),
    hash: typeof tx.hash === 'string' ? tx.hash : undefined,
    ledgerIndex: typeof tx.ledger_index === 'number' ? tx.ledger_index : undefined,
    sequence: typeof tx.Sequence === 'number' ? tx.Sequence : undefined,
    date: typeof tx.date === 'number' ? new Date(rippleTimeToUnixTime(tx.date)) : undefined,
  }
}

/** How many `account_tx` pages (of up to 200 rows) to read for an issuance's history before stopping. */
const ISSUANCE_HISTORY_PAGES = 10

/**
 * Every transaction in `account`'s available history that names this
 * issuance, newest first (see `IssuanceTransaction`). Reads at most
 * `ISSUANCE_HISTORY_PAGES` pages; a failed page throws.
 */
export async function getIssuanceTransactions(account: string, mptIssuanceId: string): Promise<IssuanceTransaction[]> {
  const client = await getClient()
  const found: IssuanceTransaction[] = []
  let marker: unknown
  for (let page = 0; page < ISSUANCE_HISTORY_PAGES; page++) {
    const { result } = await client.request({
      command: 'account_tx',
      account,
      api_version: 1,
      binary: false,
      forward: false,
      limit: 200,
      marker,
    })
    for (const row of result.transactions) {
      const entry = issuanceTransactionOf(row, mptIssuanceId)
      if (entry) found.push(entry)
    }
    marker = result.marker
    if (marker == null) break
  }
  return found
}

/**
 * Admission requests still waiting, newest first: requests in the issuer's
 * history with no admission after them (at most `max`, skipping `exclude`),
 * each confirmed on the ledger as a holding the Register hasn't admitted.
 * A candidate whose holding can't be read is left out.
 */
export async function getPendingRequests(
  history: IssuanceTransaction[],
  issuer: string,
  mptIssuanceId: string,
  exclude: string[],
  max = 5,
): Promise<AdmissionRequest[]> {
  const candidates = unadmittedRequests(admissionRequestsOf(history, issuer), admissionsOf(history, issuer), exclude).slice(0, max)
  const holdings = await Promise.allSettled(candidates.map((request) => getMptHolding(request.account, mptIssuanceId)))
  return candidates.filter((_, i) => {
    const holding = holdings[i]
    return holding?.status === 'fulfilled' && holding.value.hasHolding && !holding.value.admitted
  })
}

/** Each account's holding, read in parallel. An account whose read fails is left out of the map. */
export async function getMptHoldings(addresses: string[], mptIssuanceId: string): Promise<Map<string, MptHolding>> {
  const reads = await Promise.allSettled(addresses.map((address) => getMptHolding(address, mptIssuanceId)))
  const holdings = new Map<string, MptHolding>()
  reads.forEach((read, i) => {
    if (read.status === 'fulfilled') holdings.set(addresses[i]!, read.value)
  })
  return holdings
}

/** The dealing-day label an issue carries (memo type `mint-period`), if any. */
export function mintPeriodOf(memos: TextMemo[]): string | undefined {
  return memos.find((memo) => memo.type === 'mint-period' && memo.data)?.data
}

export interface MintRecord {
  period: string
  amountRaw: string
  hash?: string
  destination?: string
  ledgerIndex?: number
  /** The issuing account's sequence, which identifies the transaction. */
  sequence?: number
  date?: Date
}

/** Successful outgoing issues of this issuance that carry a dealing-day memo, across every available page. */
export async function getMintHistory(issuerAddress: string, mptIssuanceId: string): Promise<MintRecord[]> {
  const payments = await getOutgoingMptPayments(issuerAddress, mptIssuanceId)
  return payments.flatMap((payment) => {
    const period = mintPeriodOf(payment.memos)
    if (!period) return []
    return [
      {
        period,
        amountRaw: payment.amountRaw,
        hash: payment.hash,
        destination: payment.destination,
        ledgerIndex: payment.ledgerIndex,
        sequence: payment.sequence,
        date: payment.date,
      },
    ]
  })
}

/**
 * Suggests the next dealing day (`YYYY-MM`): the month after the latest
 * dealing day on record, or the current month when there is none. Older
 * numeric labels still count when they name a month (`202610`); a bare year
 * (`2026`) doesn't.
 */
export function suggestNextMintPeriod(history: MintRecord[], now: Date = new Date()): string {
  return suggestNextDealingDay(
    history.map((record) => record.period),
    now,
  )
}

export type ProposalStatus =
  | { status: 'pending' }
  /** This proposal is on the ledger and succeeded. */
  | { status: 'done'; hash?: string }
  /** This proposal is on the ledger but failed (a `tec` result): its fee and sequence are spent and nothing moved. */
  | { status: 'failed'; result: string; hash?: string }
  /** A different transaction used the sequence, so this proposal can never be submitted. */
  | { status: 'superseded'; hash?: string }
  /** The sequence is used, but the transaction that used it isn't in the history this server holds. */
  | { status: 'unknown' }

/** The fields that identify a prepared multisig proposal. */
export interface ProposalIdentity {
  Account?: unknown
  Sequence?: unknown
  TransactionType?: unknown
  Destination?: unknown
  Amount?: unknown
  /** The account an admission, stop-transfer or clawback names. */
  Holder?: unknown
  MPTokenIssuanceID?: unknown
  /** A stop-transfer and its release differ only here (tfMPTLock, tfMPTUnlock). */
  Flags?: unknown
}

export interface LandedTransaction {
  tx: Record<string, unknown>
  result: string
  hash?: string
}

/** How many account_tx pages to read looking for a sequence before giving up. */
const SEQUENCE_SEARCH_PAGES = 5

/**
 * The validated transaction `account` sent with `sequence`, successful or
 * not (a `tec` result spends the sequence too), newest first. Stops once it
 * reaches the account's older sequences.
 */
export async function findTransactionBySequence(account: string, sequence: number): Promise<LandedTransaction | undefined> {
  const client = await getClient()
  let marker: unknown
  for (let page = 0; page < SEQUENCE_SEARCH_PAGES; page++) {
    const { result } = await client.request({
      command: 'account_tx',
      account,
      api_version: 1,
      binary: false,
      forward: false,
      limit: 100,
      marker,
    })
    for (const row of result.transactions) {
      const tx = row.tx as Record<string, unknown> | undefined
      if (!row.validated || !tx || tx.Account !== account || typeof tx.Sequence !== 'number') continue
      if (tx.Sequence === sequence) {
        const meta = row.meta as { TransactionResult?: unknown } | undefined
        return {
          tx,
          result: typeof meta?.TransactionResult === 'string' ? meta.TransactionResult : 'unknown',
          hash: typeof tx.hash === 'string' ? tx.hash : undefined,
        }
      }
      // Newest first: a lower sequence (tickets use 0) means we've passed it.
      if (tx.Sequence > 0 && tx.Sequence < sequence) return undefined
    }
    marker = result.marker
    if (marker == null) return undefined
  }
  return undefined
}

function sameAmount(a: unknown, b: unknown): boolean {
  // An admission carries no amount at all.
  if (a === undefined || b === undefined) return a === b
  if (typeof a === 'string' || typeof b === 'string') return a === b
  const x = a as { mpt_issuance_id?: unknown; value?: unknown } | undefined
  const y = b as { mpt_issuance_id?: unknown; value?: unknown } | undefined
  return Boolean(x && y) && x!.mpt_issuance_id === y!.mpt_issuance_id && String(x!.value) === String(y!.value)
}

/** tfFullyCanonicalSig: set by some signers on any transaction, and says nothing about what it does. */
const TF_FULLY_CANONICAL_SIG = 0x80000000

/** Numeric flags without tfFullyCanonicalSig; an absent field is 0. Undefined for any other shape. */
function flagBits(flags: unknown): number | undefined {
  if (flags === undefined) return 0
  if (typeof flags !== 'number') return undefined
  return (flags & ~TF_FULLY_CANONICAL_SIG) >>> 0
}

/** Whether a landed transaction is this proposal: same sender, sequence, type, destination, amount, holder, issuance and flags. */
export function isSameProposal(landed: Record<string, unknown>, proposal: ProposalIdentity): boolean {
  const flags = flagBits(landed.Flags)
  return (
    landed.Account === proposal.Account &&
    landed.Sequence === proposal.Sequence &&
    landed.TransactionType === proposal.TransactionType &&
    landed.Destination === proposal.Destination &&
    sameAmount(landed.Amount, proposal.Amount) &&
    landed.Holder === proposal.Holder &&
    landed.MPTokenIssuanceID === proposal.MPTokenIssuanceID &&
    flags !== undefined &&
    flags === flagBits(proposal.Flags)
  )
}

/**
 * Checks a prepared multisig proposal: still `pending` while the account's
 * sequence hasn't moved past it. Once it has, the transaction that used the
 * sequence says what happened: `done` if it's this proposal and succeeded,
 * `failed` (with the ledger's result code) if it's this proposal and failed,
 * `superseded` if it's a different transaction.
 */
export async function getProposalStatus(proposal: ProposalIdentity): Promise<ProposalStatus> {
  const account = String(proposal.Account ?? '')
  const sequence = proposal.Sequence
  if (!account || typeof sequence !== 'number') throw new Error('The proposal has no account or sequence.')
  const client = await getClient()
  const info = await client.command.accountInfo({ account, ledger_index: 'validated' })
  if (info.result.account_data.Sequence <= sequence) return { status: 'pending' }
  const landed = await findTransactionBySequence(account, sequence)
  if (!landed) return { status: 'unknown' }
  if (!isSameProposal(landed.tx, proposal)) return { status: 'superseded', hash: landed.hash }
  if (landed.result === 'tesSUCCESS') return { status: 'done', hash: landed.hash }
  return { status: 'failed', result: landed.result, hash: landed.hash }
}

/**
 * Polls a proposal until it settles (a co-signer's GhostSig submits it, or
 * its sequence is used by something else) and calls `onSettled` once.
 * Read failures are retried on the next tick. Returns a stop function.
 */
export function watchProposal(
  proposal: ProposalIdentity,
  onSettled: (status: Exclude<ProposalStatus, { status: 'pending' }>) => void,
  intervalMs = 5_000,
): () => void {
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const tick = async () => {
    if (stopped) return
    try {
      const status = await getProposalStatus(proposal)
      if (status.status !== 'pending' && !stopped) {
        stopped = true
        onSettled(status)
        return
      }
    } catch {
      /* A failed read says nothing about the proposal; try again. */
    }
    if (!stopped) timer = setTimeout(tick, intervalMs)
  }
  timer = setTimeout(tick, intervalMs)
  return () => {
    stopped = true
    if (timer) clearTimeout(timer)
  }
}
