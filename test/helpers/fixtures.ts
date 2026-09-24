import { Client, Wallet } from 'xrpl'
import { connectClient } from '../../src/lib/client.js'
import { fundNewWallet, fundSignerWallets } from '../../src/lib/fund.js'
import { bootstrapGovernance, bootstrapIssuer, masterWallet } from '../../src/lib/bootstrap.js'
import { readIssuanceConfig } from '../../src/lib/mpt.js'
import { buildMptMetadataHex, readTokenMetadataConfig } from '../../src/lib/metadata.js'
import type { AccountState, IssuanceState } from '../../src/lib/config.js'
import type { NetworkConfig } from '../../src/lib/network.js'

export const SIGNER_COUNT = 3
export const SIGNER_QUORUM = 2

/**
 * Env for a test run. The issuance options are pinned to their defaults (open
 * holding, whole units) so that a developer's own .env can't change what the
 * existing tests expect; `requireAuthEnv` turns them on.
 */
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
    MPT_REQUIRE_AUTH: 'false',
    TOKEN_ASSET_SCALE: '0',
  }
}

/** `testEnv` with RequireAuth on and AssetScale 3. */
export function requireAuthEnv(wsUrl: string): NodeJS.ProcessEnv {
  return { ...testEnv(wsUrl), MPT_REQUIRE_AUTH: 'true', TOKEN_ASSET_SCALE: '3' }
}

function toAccountState(
  wallet: Wallet,
  signers: AccountState['signers'],
  quorum: number,
  masterKeyDisablePending?: boolean,
): AccountState {
  return { address: wallet.address, seed: wallet.seed!, signers, quorum, masterKeyDisablePending }
}

/**
 * Funds and configures an issuer account with the same bootstrap steps as
 * `setup-issuer.ts`: single-sig issuance, then multisig. The master key is
 * disabled here, unless the issuance has RequireAuth: then it stays enabled
 * until `setupGovernance` has admitted the governance account.
 */
export async function setupIssuer(
  client: Client,
  network: NetworkConfig,
  env: NodeJS.ProcessEnv,
): Promise<{ issuer: AccountState; mptIssuanceId: string; issuance: IssuanceState }> {
  const issuerWallet = await fundNewWallet(client, network)
  const signers = await fundSignerWallets(client, network, SIGNER_COUNT)

  const result = await bootstrapIssuer(client, issuerWallet, {
    signers,
    quorum: SIGNER_QUORUM,
    config: readIssuanceConfig(env),
    metadataHex: buildMptMetadataHex(readTokenMetadataConfig(env)),
  })

  return {
    issuer: toAccountState(issuerWallet, signers, SIGNER_QUORUM, result.masterKeyDisablePending || undefined),
    mptIssuanceId: result.mptIssuanceId,
    issuance: result.issuance,
  }
}

/**
 * Funds and configures a governance account with the same bootstrap steps as
 * `setup-governance.ts`: single-sig self-authorize, then multisig with a
 * disabled master key. With RequireAuth, `issuer` is required: its master
 * key admits the governance account and is then disabled.
 */
export async function setupGovernance(
  client: Client,
  network: NetworkConfig,
  mptIssuanceId: string,
  issuer?: AccountState,
): Promise<AccountState> {
  const governanceWallet = await fundNewWallet(client, network)
  const signers = await fundSignerWallets(client, network, SIGNER_COUNT)

  await bootstrapGovernance(client, governanceWallet, {
    signers,
    quorum: SIGNER_QUORUM,
    mptIssuanceId,
    issuerWallet: issuer ? masterWallet(issuer) : undefined,
  })

  return toAccountState(governanceWallet, signers, SIGNER_QUORUM)
}

/**
 * Funds a plain holder wallet and self-authorizes it to hold the given MPT
 * issuance. With RequireAuth, it still needs the issuer's admission.
 */
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
