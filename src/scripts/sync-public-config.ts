import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { MPTokenIssuanceFlags } from 'xrpl'
import { loadDeploymentState, type AccountState, type DeploymentState } from '../lib/config.js'
import { readTokenMetadataConfig, type TokenMetadataConfig } from '../lib/metadata.js'

export interface PublicSignerConfig {
  address: string
}

export interface PublicAccountConfig {
  address: string
  quorum: number
  signers: PublicSignerConfig[]
}

export interface PublicTokenConfig {
  ticker: string
  name: string
  description?: string
  icon: string
  issuerName: string
}

export interface PublicDeploymentConfig {
  network: string
  mptIssuanceId?: string
  /** The issuance's AssetScale: one displayed unit is 10^assetScale ledger units. */
  assetScale?: number
  /**
   * The issuance's lsfMPT* flags that are fixed at creation (e.g. RequireAuth
   * 0x04, CanLock 0x02, CanTransfer 0x20, CanClawback 0x40). lsfMPTLocked
   * (0x01) is always cleared: the issuer multisig can lock and unlock the
   * whole issuance at any time, so read the lock state from the ledger.
   */
  flags?: number
  token: PublicTokenConfig
  issuer?: PublicAccountConfig
  governance?: PublicAccountConfig
}

function toPublicAccount(account: AccountState): PublicAccountConfig {
  return {
    address: account.address,
    quorum: account.quorum,
    signers: account.signers.map((signer) => ({ address: signer.address })),
  }
}

function toPublicToken(config: TokenMetadataConfig): PublicTokenConfig {
  return {
    ticker: config.ticker,
    name: config.name,
    description: config.description,
    icon: config.icon,
    issuerName: config.issuerName,
  }
}

/**
 * lsfMPTLocked is the one issuance flag that can change after creation (a
 * global MPTokenIssuanceSet lock or unlock). `.deployment.json` only holds a
 * snapshot from setup, so that bit is never published.
 */
function publishedIssuanceFlags(flags: number): number {
  return flags & ~MPTokenIssuanceFlags.lsfMPTLocked
}

/**
 * Builds the non-secret subset of `.deployment.json` (plus token identity
 * from TOKEN_* env vars) that's safe to publish as a static asset for the
 * `web/` frontend. Every `seed` field -- issuer/governance master seeds and
 * per-signer seeds -- is deliberately omitted; only addresses are kept.
 * `assetScale` and `flags` come from the issuance settings that
 * `setup:issuer` read back from the ledger, with the lock bit cleared from
 * `flags`; they're left out when the state has none recorded.
 */
export function buildPublicConfig(state: DeploymentState, tokenConfig: TokenMetadataConfig): PublicDeploymentConfig {
  return {
    network: state.network,
    mptIssuanceId: state.mptIssuanceId,
    assetScale: state.issuance?.assetScale,
    flags: state.issuance ? publishedIssuanceFlags(state.issuance.flags) : undefined,
    token: toPublicToken(tokenConfig),
    issuer: state.issuer ? toPublicAccount(state.issuer) : undefined,
    governance: state.governance ? toPublicAccount(state.governance) : undefined,
  }
}

/**
 * Defense-in-depth check: even though `buildPublicConfig` only ever copies
 * `address`/`quorum` fields across, this guards against a future edit
 * accidentally leaking a `seed` key into the published file.
 */
export function assertNoSeedKey(serialized: string): void {
  if (/"seed"\s*:/.test(serialized)) {
    throw new Error('Refusing to write web/public/deployment.json: output unexpectedly contains a "seed" key.')
  }
}

const OUTPUT_PATH = path.resolve(fileURLToPath(new URL('../../web/public/deployment.json', import.meta.url)))

async function main(): Promise<void> {
  const state = loadDeploymentState()
  const tokenConfig = readTokenMetadataConfig()

  if (!state.issuer) {
    console.log('Warning: no issuer in .deployment.json yet. Run `npm run setup:issuer` first for a complete config.')
  }
  if (!state.governance) {
    console.log('Warning: no governance account in .deployment.json yet. Run `npm run setup:governance` first for a complete config.')
  }
  if (state.mptIssuanceId && !state.issuance) {
    console.log(
      'Warning: no issuance settings (flags, AssetScale) in .deployment.json yet, so they are left out. Rerun `npm run setup:issuer` to read them from the ledger.',
    )
  }

  const publicConfig = buildPublicConfig(state, tokenConfig)
  const serialized = JSON.stringify(publicConfig, null, 2) + '\n'
  assertNoSeedKey(serialized)

  writeFileSync(OUTPUT_PATH, serialized, 'utf-8')
  console.log(`Wrote ${OUTPUT_PATH}`)
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err)
    process.exitCode = 1
  })
}
