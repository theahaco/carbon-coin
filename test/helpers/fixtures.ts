import { Client, Wallet } from 'xrpl'
import { connectClient } from '../../src/lib/client.js'
import { fundNewWallet, fundSignerWallets } from '../../src/lib/fund.js'
import { establishMultisigAndDisableMasterKey } from '../../src/lib/accountSetup.js'
import { MPT_ISSUANCE_FLAGS } from '../../src/lib/mpt.js'
import { buildMptMetadataHex, readTokenMetadataConfig } from '../../src/lib/metadata.js'
import type { AccountState } from '../../src/lib/config.js'
import type { NetworkConfig } from '../../src/lib/network.js'

export const SIGNER_COUNT = 3
export const SIGNER_QUORUM = 2

export function testEnv(wsUrl: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    XRPL_NETWORK: 'local',
    XRPL_WS_URL: wsUrl,
    TOKEN_TICKER: 'TEST',
    TOKEN_NAME: 'Test Token',
    TOKEN_ICON_URL: 'https://example.org/icon.png',
    TOKEN_ASSET_CLASS: 'other',
    TOKEN_ISSUER_NAME: 'Test Issuer',
  }
}

async function toAccountState(
  wallet: Wallet,
  signers: AccountState['signers'],
  quorum: number,
): Promise<AccountState> {
  return { address: wallet.address, seed: wallet.seed!, signers, quorum }
}

/**
 * Funds and fully configures an issuer account (single-sig issuance, then
 * multisig + disabled master key) exactly like `setup-issuer.ts`.
 */
export async function setupIssuer(
  client: Client,
  network: NetworkConfig,
  env: NodeJS.ProcessEnv,
): Promise<{ issuer: AccountState; mptIssuanceId: string }> {
  const issuerWallet = await fundNewWallet(client, network)
  const signers = await fundSignerWallets(client, network, SIGNER_COUNT)

  const metadataHex = buildMptMetadataHex(readTokenMetadataConfig(env))
  const signing = client.withWallet(issuerWallet)
  const issued = await signing.tx
    .mpTokenIssuanceCreate({
      MPTokenMetadata: metadataHex,
      Flags: MPT_ISSUANCE_FLAGS,
    })
    .signAndSubmit()
  const mptIssuanceId = issued.result.meta.mpt_issuance_id
  if (!mptIssuanceId) throw new Error('MPTokenIssuanceCreate did not return mpt_issuance_id')
  await establishMultisigAndDisableMasterKey(signing, signers, SIGNER_QUORUM)

  return { issuer: await toAccountState(issuerWallet, signers, SIGNER_QUORUM), mptIssuanceId }
}

/**
 * Funds and fully configures a governance account (single-sig authorize,
 * then multisig + disabled master key) exactly like `setup-governance.ts`.
 */
export async function setupGovernance(
  client: Client,
  network: NetworkConfig,
  mptIssuanceId: string,
): Promise<AccountState> {
  const governanceWallet = await fundNewWallet(client, network)
  const signers = await fundSignerWallets(client, network, SIGNER_COUNT)

  const signing = client.withWallet(governanceWallet)
  await signing.tx.mpTokenAuthorize({ MPTokenIssuanceID: mptIssuanceId }).signAndSubmit()
  await establishMultisigAndDisableMasterKey(signing, signers, SIGNER_QUORUM)

  return toAccountState(governanceWallet, signers, SIGNER_QUORUM)
}

/** Funds a plain holder wallet and authorizes it to hold the given MPT issuance. */
export async function setupAuthorizedHolder(
  client: Client,
  network: NetworkConfig,
  mptIssuanceId: string,
): Promise<Wallet> {
  const wallet = await fundNewWallet(client, network)
  const signing = client.withWallet(wallet)
  await signing.tx.mpTokenAuthorize({ MPTokenIssuanceID: mptIssuanceId }).signAndSubmit()
  return wallet
}

export { connectClient }
