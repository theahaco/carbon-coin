import { connectClient } from '../lib/client.js'
import { fundNewWallet, parseSignerAddressesEnv, resolveSignerWallets } from '../lib/fund.js'
import { bootstrapIssuer, issuanceRequiresAuth, masterWallet } from '../lib/bootstrap.js'
import { readIssuanceConfig } from '../lib/mpt.js'
import { buildMptMetadataHex, readTokenMetadataConfig } from '../lib/metadata.js'
import { loadDeploymentState, saveDeploymentState, type DeploymentState } from '../lib/config.js'

const SIGNER_COUNT = 3
const SIGNER_QUORUM = 2

async function main(): Promise<void> {
  let state: DeploymentState = loadDeploymentState()
  if (state.issuer && state.mptIssuanceId && state.issuance) {
    console.log(`Issuer already set up at ${state.issuer.address} (mpt_issuance_id: ${state.mptIssuanceId}).`)
    if (state.issuer.masterKeyDisablePending && issuanceRequiresAuth(state.issuance)) {
      console.log(
        "RequireAuth is on, so the issuer's master key is still enabled. Run `npm run setup:governance`: it admits the governance account, then disables it.",
      )
    }
    console.log(
      'Delete .deployment.json (or its "issuer", "mptIssuanceId", "issuance" and "governance" fields) to redo this from scratch. ' +
        'The governance account is set up for one issuance, so it has to be redone with the issuer.',
    )
    return
  }
  if (state.governance && !state.mptIssuanceId) {
    // The governance account was set up for an issuance that's no longer
    // recorded. Its master key is disabled, so setup:governance couldn't
    // authorize it for a new issuance, and with RequireAuth the new issuer's
    // master key would then stay enabled.
    throw new Error(
      `.deployment.json has a governance account (${state.governance.address}) but no issuance: it was set up for an earlier one. ` +
        'Delete its "governance" field too, then run `npm run setup:issuer` and `npm run setup:governance`.',
    )
  }

  const issuanceConfig = readIssuanceConfig()
  const metadataHex = buildMptMetadataHex(readTokenMetadataConfig())

  const { client, network } = await connectClient()
  try {
    console.log(`Connected to ${network.name} (${network.wsUrl}).`)

    let issuer = state.issuer
    if (issuer) {
      console.log(`Checking the setup of issuer ${issuer.address} against the ledger and resuming it.`)
    } else {
      const wallet = await fundNewWallet(client, network)
      console.log(`Funded issuer account: ${wallet.address}`)

      // Optional, additive: real (e.g. GhostSig-controlled) signer addresses
      // supplied via ISSUER_SIGNER_ADDRESSES are used as-is; any remaining
      // slots up to SIGNER_COUNT are still auto-generated placeholders exactly
      // as before. Leaving the var unset reproduces today's behavior.
      const presetSignerAddresses = parseSignerAddressesEnv(process.env.ISSUER_SIGNER_ADDRESSES)
      const signers = await resolveSignerWallets(client, network, SIGNER_COUNT, presetSignerAddresses)
      console.log(`Issuer signer set (${signers.length}): ${signers.map((s) => s.address).join(', ')}`)

      // Saved before any issuer transaction, so a failure below can be resumed
      // by rerunning this script instead of losing the funded accounts.
      issuer = { address: wallet.address, seed: wallet.seed!, signers, quorum: SIGNER_QUORUM, masterKeyDisablePending: true }
      state = { ...state, network: network.name, issuer }
      saveDeploymentState(state)
    }

    // The one-time MPTokenIssuanceCreate is signed single-sig, with the
    // issuer's still-active throwaway master key, *before* the master key is
    // disabled. Otherwise, whenever a real signer is a GhostSig-controlled
    // human rather than a script-held seed, this one-time bootstrap action
    // would itself need a live, multi-person browser ceremony just to get the
    // token issued. With RequireAuth, the master key also admits the
    // governance account in `setup:governance`, which then disables it.
    const result = await bootstrapIssuer(client, masterWallet(issuer), {
      signers: issuer.signers,
      quorum: issuer.quorum,
      config: issuanceConfig,
      metadataHex,
      mptIssuanceId: state.mptIssuanceId,
      onIssuanceId: (mptIssuanceId) => {
        state = { ...state, mptIssuanceId }
        saveDeploymentState(state)
      },
      log: console.log,
    })

    state = {
      ...state,
      network: network.name,
      issuer: { ...issuer, masterKeyDisablePending: result.masterKeyDisablePending || undefined },
      mptIssuanceId: result.mptIssuanceId,
      issuance: result.issuance,
    }
    saveDeploymentState(state)
    console.log('Saved issuer state to .deployment.json.')
  } finally {
    await client.disconnect()
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err)
  process.exitCode = 1
})
