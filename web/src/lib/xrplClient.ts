import {
  Client,
  RippledError,
  decodeMemo,
  fetchMPTokenOrUndefined,
  parseAccountRootFlags,
  parseMPTokenFlags,
  parseMPTokenIssuanceFlags,
  rippleTimeToUnixTime,
  type MPTokenIssuanceFlagsInterface,
  type TextMemo,
} from 'xrpl'
import { suggestNextDealingDay } from './dealing'
import { describeReadiness, type ReadinessNotice } from './readiness'

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
  authorized: boolean
  balanceRaw: string
  locked: boolean
}

/** Read confirmed holdings. A missing entry is distinct from a failed network read. */
export async function getMptHolding(address: string, mptIssuanceId: string): Promise<MptHolding> {
  const client = await getClient()
  const token = await fetchMPTokenOrUndefined(client, address, mptIssuanceId, 'validated')
  return {
    authorized: token !== undefined,
    balanceRaw: token?.MPTAmount ?? '0',
    locked: token ? Boolean(parseMPTokenFlags(token.Flags).lsfMPTLocked) : false,
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
  opts: { source: string; amount?: string },
): Promise<ReadinessNotice | null> {
  const client = await getClient()
  const readiness = await client.getMptTransferReadiness({ account, destination, mptIssuanceId, amount: opts.amount })
  return describeReadiness(readiness, { destination, source: opts.source })
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
  if (typeof a === 'string' || typeof b === 'string') return a === b
  const x = a as { mpt_issuance_id?: unknown; value?: unknown } | undefined
  const y = b as { mpt_issuance_id?: unknown; value?: unknown } | undefined
  return Boolean(x && y) && x!.mpt_issuance_id === y!.mpt_issuance_id && String(x!.value) === String(y!.value)
}

/** Whether a landed transaction is this proposal: same sender, sequence, type, destination and amount. */
export function isSameProposal(landed: Record<string, unknown>, proposal: ProposalIdentity): boolean {
  return (
    landed.Account === proposal.Account &&
    landed.Sequence === proposal.Sequence &&
    landed.TransactionType === proposal.TransactionType &&
    landed.Destination === proposal.Destination &&
    sameAmount(landed.Amount, proposal.Amount)
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
