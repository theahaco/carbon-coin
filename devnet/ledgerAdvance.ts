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
 * Used two ways:
 * - In-process, by the integration test helper (`test/helpers/localNetwork.ts`),
 *   which calls `stop()` in the test file's `afterAll`.
 * - As a detached background process (see `devnet/ledgerAdvanceProcess.ts`),
 *   spawned by `npm run devnet:up` so the loop keeps running independent of
 *   any single script invocation, and killed by `npm run devnet:down`.
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
