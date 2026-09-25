import { Client } from 'xrpl'

export interface LedgerAdvanceLoop {
  stop: () => Promise<void>
}

/**
 * Stand-alone rippled never closes ledgers on its own. This connects an
 * admin WS client and calls the admin `ledger_accept` RPC on a short
 * interval so that transactions submitted against `wsUrl` actually
 * validate.
 *
 * Test-only: SDK assertions need automatic ledger closes. The operational
 * Rust CLI uses tx submit --wait --accept-ledger instead.
 */
export async function startLedgerAdvanceLoop(wsUrl: string, intervalMs = 500): Promise<LedgerAdvanceLoop> {
  const client = new Client(wsUrl)
  await client.connect()

  const interval = setInterval(() => {
    client.command.ledgerAccept().catch(() => {})
  }, intervalMs)

  return {
    stop: async () => {
      clearInterval(interval)
      await client.disconnect().catch(() => {})
    },
  }
}
