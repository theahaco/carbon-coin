import type { Client } from 'xrpl'
import { fetchMPTokenOrUndefined } from 'xrpl'
import { connectClient } from '../lib/client.js'
import { loadDeploymentState, type AccountState } from '../lib/config.js'

async function printAccountStatus(
  client: Client,
  label: string,
  account: AccountState,
  mptIssuanceId?: string,
): Promise<void> {
  console.log(`\n${label}: ${account.address}`)

  const signerLists = await client.command.accountObjects({ account: account.address, type: 'signer_list' })
  const signerList = signerLists.result.account_objects[0]
  if (signerList) {
    const entries = (signerList.SignerEntries ?? []).map((e) => e.SignerEntry.Account)
    console.log(`  SignerList: quorum ${signerList.SignerQuorum} of [${entries.join(', ')}]`)
  } else {
    console.log('  SignerList: none configured')
  }

  const accountInfo = await client.command.accountInfo({ account: account.address })
  const masterKeyDisabled = accountInfo.result.account_flags?.disableMasterKey ?? false
  console.log(`  Master key disabled: ${masterKeyDisabled}`)

  if (mptIssuanceId) {
    const mptoken = await fetchMPTokenOrUndefined(client, account.address, mptIssuanceId, 'validated')
    console.log(`  MPT balance: ${mptoken ? (mptoken.MPTAmount ?? '0') : '(not authorized)'}`)
  }
}

async function main(): Promise<void> {
  const state = loadDeploymentState()
  const { client, network } = await connectClient()
  try {
    console.log(`Connected to ${network.name} (${network.wsUrl}).`)

    if (state.mptIssuanceId) {
      const issuance = await client.command.ledgerEntry({ mpt_issuance: state.mptIssuanceId })
      const node = issuance.result.node
      console.log(`\nMPTokenIssuance: ${state.mptIssuanceId}`)
      console.log(`  Outstanding amount: ${node.OutstandingAmount}`)
      console.log(`  Flags: ${node.Flags}`)
      console.log(`  Maximum amount: ${node.MaximumAmount ?? '(default cap, 2^63-1)'}`)
    } else {
      console.log('\nNo MPT issuance yet. Run `npm run setup:issuer`.')
    }

    if (state.issuer) {
      await printAccountStatus(client, 'Issuer', state.issuer)
    } else {
      console.log('\nNo issuer yet. Run `npm run setup:issuer`.')
    }

    if (state.governance) {
      await printAccountStatus(client, 'Governance', state.governance, state.mptIssuanceId)
    } else {
      console.log('\nNo governance account yet. Run `npm run setup:governance`.')
    }

    if (state.mintedPeriods?.length) {
      console.log(`\nMinted periods on record: ${state.mintedPeriods.join(', ')}`)
    }
  } finally {
    await client.disconnect()
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err)
  process.exitCode = 1
})
