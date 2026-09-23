import { connectClient } from '../lib/client.js'
import { fundNewWallet, parseSignerAddressesEnv, resolveSignerWallets } from '../lib/fund.js'
import { establishMultisigAndDisableMasterKey } from '../lib/accountSetup.js'
import { loadDeploymentState, requireMptIssuanceId, saveDeploymentState } from '../lib/config.js'

const SIGNER_COUNT = 3
const SIGNER_QUORUM = 2

async function main(): Promise<void> {
  const state = loadDeploymentState()
  if (state.governance) {
    console.log(`Governance already set up at ${state.governance.address}.`)
    console.log('Delete .deployment.json (or its "governance" field) to redo this from scratch.')
    return
  }
  const mptIssuanceId = requireMptIssuanceId(state)

  const { client, network } = await connectClient()
  try {
    console.log(`Connected to ${network.name} (${network.wsUrl}).`)

    const governance = await fundNewWallet(client, network)
    console.log(`Funded governance account: ${governance.address}`)

    // Optional, additive: real (e.g. GhostSig-controlled) signer addresses
    // supplied via GOVERNANCE_SIGNER_ADDRESSES are used as-is; any remaining
    // slots up to SIGNER_COUNT are still auto-generated placeholders exactly
    // as before. Leaving the var unset reproduces today's behavior.
    const presetSignerAddresses = parseSignerAddressesEnv(process.env.GOVERNANCE_SIGNER_ADDRESSES)
    const signers = await resolveSignerWallets(client, network, SIGNER_COUNT, presetSignerAddresses)
    console.log(`Governance signer set (${signers.length}): ${signers.map((s) => s.address).join(', ')}`)

    // Same bootstrap-ordering rationale as setup-issuer.ts: the one-time
    // MPTokenAuthorize is signed single-sig, with the still-active throwaway
    // master key, *before* the multisig is established below.
    const signing = client.withWallet(governance)
    await signing.tx.mpTokenAuthorize({ MPTokenIssuanceID: mptIssuanceId }).signAndSubmit()
    console.log('Governance account authorized to hold the MPT.')
    await establishMultisigAndDisableMasterKey(signing, signers, SIGNER_QUORUM)
    console.log(
      `Configured ${SIGNER_QUORUM}-of-${signers.length} multisig and disabled the governance account's master key.`,
    )

    saveDeploymentState({
      ...state,
      governance: { address: governance.address, seed: governance.seed!, signers, quorum: SIGNER_QUORUM },
    })
    console.log('Saved governance state to .deployment.json.')
  } finally {
    await client.disconnect()
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err)
  process.exitCode = 1
})
