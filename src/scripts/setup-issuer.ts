import { connectClient } from '../lib/client.js'
import { fundNewWallet, parseSignerAddressesEnv, resolveSignerWallets } from '../lib/fund.js'
import { establishMultisigAndDisableMasterKey } from '../lib/accountSetup.js'
import { MPT_ISSUANCE_FLAGS } from '../lib/mpt.js'
import { buildMptMetadataHex, readTokenMetadataConfig } from '../lib/metadata.js'
import { loadDeploymentState, saveDeploymentState } from '../lib/config.js'

const SIGNER_COUNT = 3
const SIGNER_QUORUM = 2

async function main(): Promise<void> {
  const state = loadDeploymentState()
  if (state.issuer) {
    console.log(`Issuer already set up at ${state.issuer.address} (mpt_issuance_id: ${state.mptIssuanceId}).`)
    console.log('Delete .deployment.json (or its "issuer"/"mptIssuanceId" fields) to redo this from scratch.')
    return
  }

  const { client, network } = await connectClient()
  try {
    console.log(`Connected to ${network.name} (${network.wsUrl}).`)

    const issuer = await fundNewWallet(client, network)
    console.log(`Funded issuer account: ${issuer.address}`)

    // Optional, additive: real (e.g. GhostSig-controlled) signer addresses
    // supplied via ISSUER_SIGNER_ADDRESSES are used as-is; any remaining
    // slots up to SIGNER_COUNT are still auto-generated placeholders exactly
    // as before. Leaving the var unset reproduces today's behavior.
    const presetSignerAddresses = parseSignerAddressesEnv(process.env.ISSUER_SIGNER_ADDRESSES)
    const signers = await resolveSignerWallets(client, network, SIGNER_COUNT, presetSignerAddresses)
    console.log(`Issuer signer set (${signers.length}): ${signers.map((s) => s.address).join(', ')}`)

    // The one-time MPTokenIssuanceCreate is signed single-sig, with the
    // issuer's still-active throwaway master key, *before* the multisig is
    // established below. Otherwise, whenever a real signer is a
    // GhostSig-controlled human rather than a script-held seed, this
    // one-time bootstrap action would itself need a live, multi-person
    // browser ceremony just to get the token issued.
    const metadataHex = buildMptMetadataHex(readTokenMetadataConfig())
    const signing = client.withWallet(issuer)
    const issued = await signing.tx
      .mpTokenIssuanceCreate({
        MPTokenMetadata: metadataHex,
        Flags: MPT_ISSUANCE_FLAGS,
      })
      .signAndSubmit()
    const mptIssuanceId = issued.result.meta.mpt_issuance_id
    if (!mptIssuanceId)
      throw new Error('MPTokenIssuanceCreate succeeded but no mpt_issuance_id was returned.')
    console.log(`Created MPT issuance: ${mptIssuanceId}`)
    await establishMultisigAndDisableMasterKey(signing, signers, SIGNER_QUORUM)
    console.log(
      `Configured ${SIGNER_QUORUM}-of-${signers.length} multisig and disabled the issuer's master key.`,
    )

    saveDeploymentState({
      ...state,
      network: network.name,
      issuer: { address: issuer.address, seed: issuer.seed!, signers, quorum: SIGNER_QUORUM },
      mptIssuanceId,
    })
    console.log('Saved issuer state to .deployment.json.')
  } finally {
    await client.disconnect()
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err)
  process.exitCode = 1
})
