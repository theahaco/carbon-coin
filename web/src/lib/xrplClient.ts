import { Client, RippledError, decodeMemo, fetchMPTokenOrUndefined, parseMPTokenFlags } from 'xrpl'

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

/** Advisory checks for this transfer; failed reads remain visible as errors. */
export async function destinationReadinessWarning(
  account: string,
  destination: string,
  mptIssuanceId: string,
  amount?: string,
): Promise<string | null> {
  const client = await getClient()
  const readiness = await client.getMptTransferReadiness({ account, destination, mptIssuanceId, amount })
  if (readiness.status === 'eligible') return null
  return readiness.checks
    .filter((check) => check.status !== 'pass')
    .map((check) => check.message)
    .join(' ')
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

export interface MintRecord {
  period: string
  amountRaw: string
  hash?: string
}

/** Successful outgoing mints of this issuance across every available page. */
export async function getMintHistory(issuerAddress: string, mptIssuanceId: string): Promise<MintRecord[]> {
  const client = await getClient()
  const { payments } = await client.getMptPaymentHistory(issuerAddress, mptIssuanceId)
  return payments.flatMap(({ transaction, deliveredAmount, hash }) => {
    if (deliveredAmount === undefined) return []
    for (const memo of transaction.Memos ?? []) {
      try {
        const { type, data } = decodeMemo(memo)
        if (type === 'mint-period' && data) return [{ period: data, amountRaw: deliveredAmount, hash }]
      } catch {
        /* Binary or malformed memos cannot describe a mint period. */
      }
    }
    return []
  })
}

/** Suggests the next mint period: the highest numeric period on record, plus one; falls back to the current year. */
export function suggestNextMintPeriod(history: MintRecord[]): string {
  const numericPeriods = history
    .map((record) => record.period)
    .filter((period) => /^\d+$/.test(period))
    .map((period) => Number.parseInt(period, 10))
  if (numericPeriods.length === 0) return String(new Date().getFullYear())
  return String(Math.max(...numericPeriods) + 1)
}
