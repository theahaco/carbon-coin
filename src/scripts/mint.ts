import { connectClient } from '../lib/client.js'
import { localSigners } from '../lib/multisig.js'
import { describeLedgerAmount } from '../lib/mpt.js'
import { encodeMemo } from 'xrpl'
import {
  loadDeploymentState,
  requireGovernance,
  requireIssuer,
  requireMptIssuanceId,
  saveDeploymentState,
} from '../lib/config.js'

const MEMO_TYPE = 'mint-period'

function parseArgs(argv: string[]): { amount: string; period: string; force: boolean } {
  const positional = argv.filter((a) => !a.startsWith('--'))
  const force = argv.includes('--force')
  const amount = positional[0]
  const period = positional[1] ?? String(new Date().getFullYear())

  if (!amount || !/^\d+$/.test(amount)) {
    throw new Error(
      'Usage: npm run mint -- <amount> [period] [--force]\n  <amount> must be a whole non-negative integer: the ledger value, in 10^-AssetScale units (with AssetScale 3, 1000 is 1.000).',
    )
  }
  return { amount, period, force }
}

async function main(): Promise<void> {
  const { amount, period, force } = parseArgs(process.argv.slice(2))

  const state = loadDeploymentState()
  const issuer = requireIssuer(state)
  const governance = requireGovernance(state)
  const mptIssuanceId = requireMptIssuanceId(state)

  const alreadyMinted = (state.mintedPeriods ?? []).includes(period)
  if (alreadyMinted && !force) {
    throw new Error(
      `A mint for period "${period}" has already been recorded in .deployment.json. ` +
        'If this is intentional (e.g. a correction), re-run with --force.',
    )
  }

  const { client, network } = await connectClient()
  try {
    console.log(`Connected to ${network.name} (${network.wsUrl}).`)
    console.log(
      `Minting ${describeLedgerAmount(amount, state.issuance?.assetScale)} for period "${period}" to governance account ${governance.address}...`,
    )

    const result = await client
      .forAccount(issuer.address)
      .tx.payment({
        Destination: governance.address,
        Amount: { mpt_issuance_id: mptIssuanceId, value: amount },
        Memos: [encodeMemo({ type: MEMO_TYPE, data: period })],
      })
      .multisignAndSubmit(localSigners(issuer.signers, issuer.quorum))
    console.log(`Mint succeeded (tx hash: ${result.result.hash}).`)

    const mintedPeriods = [...(state.mintedPeriods ?? [])]
    if (!alreadyMinted) mintedPeriods.push(period)
    saveDeploymentState({ ...state, mintedPeriods })
  } finally {
    await client.disconnect()
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err)
  process.exitCode = 1
})
