import type { Client } from 'xrpl'
import {
  fetchMPTokenIssuance,
  fetchMPTokenOrUndefined,
  parseMPTokenFlags,
  parseMPTokenIssuanceFlags,
  unitsToMpt,
} from 'xrpl'
import { connectClient } from '../lib/client.js'
import { loadDeploymentState, type AccountState } from '../lib/config.js'

interface IssuanceSummary {
  mptIssuanceId: string
  requireAuth: boolean
  assetScale: number
}

function formatAmount(raw: string, assetScale: number): string {
  return assetScale > 0 ? `${raw} (${unitsToMpt(raw, assetScale)} units at AssetScale ${assetScale})` : raw
}

function yesNo(value: boolean | undefined): string {
  return value ? 'yes' : 'no'
}

/** Prints one account and returns whether its master key is disabled. */
async function printAccountStatus(
  client: Client,
  label: string,
  account: AccountState,
  issuance?: IssuanceSummary,
): Promise<boolean> {
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
  if (!masterKeyDisabled && account.masterKeyDisablePending) {
    console.log('  (setup not finished: the master key is still enabled on purpose)')
  }

  if (issuance) {
    const mptoken = await fetchMPTokenOrUndefined(client, account.address, issuance.mptIssuanceId, 'validated')
    if (!mptoken) {
      console.log('  MPT balance: (not authorized)')
    } else {
      console.log(`  MPT balance: ${formatAmount(mptoken.MPTAmount ?? '0', issuance.assetScale)}`)
      const flags = parseMPTokenFlags(mptoken.Flags)
      console.log(
        `  Admitted by the issuer: ${issuance.requireAuth ? yesNo(flags.lsfMPTAuthorized) : 'not required (RequireAuth off)'}`,
      )
      if (flags.lsfMPTLocked) console.log('  Locked by the issuer: yes')
    }
  }
  return masterKeyDisabled
}

async function main(): Promise<void> {
  const state = loadDeploymentState()
  const { client, network } = await connectClient()
  try {
    console.log(`Connected to ${network.name} (${network.wsUrl}).`)

    let issuance: IssuanceSummary | undefined
    if (state.mptIssuanceId) {
      const node = await fetchMPTokenIssuance(client, state.mptIssuanceId, 'validated')
      const flags = parseMPTokenIssuanceFlags(node.Flags)
      const assetScale = node.AssetScale ?? 0
      issuance = { mptIssuanceId: state.mptIssuanceId, requireAuth: flags.lsfMPTRequireAuth ?? false, assetScale }
      const flagNames = Object.keys(flags).map((name) => name.replace(/^lsfMPT/, ''))
      console.log(`\nMPTokenIssuance: ${state.mptIssuanceId}`)
      console.log(`  Outstanding amount: ${formatAmount(node.OutstandingAmount, assetScale)}`)
      console.log(`  Flags: ${node.Flags}${flagNames.length ? ` (${flagNames.join(', ')})` : ''}`)
      console.log(`  RequireAuth: ${yesNo(flags.lsfMPTRequireAuth)}`)
      console.log(`  AssetScale: ${assetScale}`)
      console.log(`  Maximum amount: ${node.MaximumAmount ?? '(default cap, 2^63-1)'}`)
    } else {
      console.log('\nNo MPT issuance yet. Run `npm run setup:issuer`.')
    }

    let issuerMasterKeyDisabled: boolean | undefined
    if (state.issuer) {
      issuerMasterKeyDisabled = await printAccountStatus(client, 'Issuer', state.issuer)
    } else {
      console.log('\nNo issuer yet. Run `npm run setup:issuer`.')
    }

    let governanceMasterKeyDisabled: boolean | undefined
    if (state.governance) {
      governanceMasterKeyDisabled = await printAccountStatus(client, 'Governance', state.governance, issuance)
    } else {
      console.log('\nNo governance account yet. Run `npm run setup:governance`.')
    }

    if (state.issuer && state.governance) {
      console.log(`\nBoth master keys disabled: ${yesNo(issuerMasterKeyDisabled && governanceMasterKeyDisabled)}`)
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
