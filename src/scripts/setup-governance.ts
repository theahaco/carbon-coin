import { connectClient } from '../lib/client.js'
import { fundNewWallet, parseSignerAddressesEnv, resolveSignerWallets } from '../lib/fund.js'
import { bootstrapGovernance, masterWallet } from '../lib/bootstrap.js'
import {
  loadDeploymentState,
  requireMptIssuanceId,
  saveDeploymentState,
  type DeploymentState,
} from '../lib/config.js'

const SIGNER_COUNT = 3
const SIGNER_QUORUM = 2

async function main(): Promise<void> {
  let state: DeploymentState = loadDeploymentState()
  if (state.governance && !state.governance.masterKeyDisablePending && !state.issuer?.masterKeyDisablePending) {
    console.log(`Governance already set up at ${state.governance.address}.`)
    console.log('Delete .deployment.json (or its "governance" field) to redo this from scratch.')
    return
  }
  const mptIssuanceId = requireMptIssuanceId(state)
  if (state.issuer?.masterKeyDisablePending && !state.issuance) {
    throw new Error('The issuer setup did not finish. Rerun `npm run setup:issuer` first.')
  }

  const { client, network } = await connectClient()
  try {
    console.log(`Connected to ${network.name} (${network.wsUrl}).`)

    let governance = state.governance
    if (governance) {
      console.log(`Checking the setup of governance account ${governance.address} against the ledger and resuming it.`)
    } else {
      const wallet = await fundNewWallet(client, network)
      console.log(`Funded governance account: ${wallet.address}`)

      // Optional, additive: real (e.g. GhostSig-controlled) signer addresses
      // supplied via GOVERNANCE_SIGNER_ADDRESSES are used as-is; any remaining
      // slots up to SIGNER_COUNT are still auto-generated placeholders exactly
      // as before. Leaving the var unset reproduces today's behavior.
      const presetSignerAddresses = parseSignerAddressesEnv(process.env.GOVERNANCE_SIGNER_ADDRESSES)
      const signers = await resolveSignerWallets(client, network, SIGNER_COUNT, presetSignerAddresses)
      console.log(`Governance signer set (${signers.length}): ${signers.map((s) => s.address).join(', ')}`)

      // Saved before any governance transaction, so a failure below can be
      // resumed by rerunning this script.
      governance = { address: wallet.address, seed: wallet.seed!, signers, quorum: SIGNER_QUORUM, masterKeyDisablePending: true }
      state = { ...state, governance }
      saveDeploymentState(state)
    }

    // Same bootstrap-ordering rationale as setup-issuer.ts: the one-time
    // MPTokenAuthorize is signed single-sig, with the still-active throwaway
    // master key, *before* the multisig is established. With RequireAuth,
    // the issuer's master key (kept enabled by setup-issuer for this) then
    // admits the governance account, and both master keys are disabled.
    // The issuer wallet is only used when the issuance has RequireAuth.
    const { requireAuth } = await bootstrapGovernance(client, masterWallet(governance), {
      signers: governance.signers,
      quorum: governance.quorum,
      mptIssuanceId,
      issuerWallet: state.issuer ? masterWallet(state.issuer) : undefined,
      log: console.log,
    })

    state = {
      ...state,
      governance: { ...governance, masterKeyDisablePending: undefined },
      ...(requireAuth && state.issuer ? { issuer: { ...state.issuer, masterKeyDisablePending: undefined } } : {}),
    }
    saveDeploymentState(state)
    console.log('Saved governance state to .deployment.json.')
  } finally {
    await client.disconnect()
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err)
  process.exitCode = 1
})
