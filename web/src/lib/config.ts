// Mirrors the (non-secret) shape written by `src/scripts/sync-public-config.ts`.

import { withBase } from './paths'
import { setLedgerScale } from './units'

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
  /** The issuance's AssetScale. Absent in configs written before it was published. */
  assetScale?: number
  /**
   * The issuance's lsfMPT* flags that are fixed at creation (parse with
   * parseMPTokenIssuanceFlags). lsfMPTLocked is always cleared here: read the
   * lock state from the ledger. Absent in older configs.
   */
  flags?: number
  token: PublicTokenConfig
  issuer?: PublicAccountConfig
  governance?: PublicAccountConfig
}

/**
 * `lsfMPTRequireAuth` on an MPTokenIssuance. Spelled out rather than parsed
 * with the SDK so this module (loaded on every page, via the header) doesn't
 * pull the SDK into pages that never touch the ledger.
 */
const LSF_MPT_REQUIRE_AUTH = 0x00000004

let cachedConfig: Promise<PublicDeploymentConfig> | undefined

/**
 * Fetches (and caches for the lifetime of the page) `deployment.json`. It
 * also sets the units scale from the issuance's `assetScale`, so every
 * amount formatted after the config has loaded uses the ledger's own scale.
 */
export function loadPublicConfig(): Promise<PublicDeploymentConfig> {
  if (!cachedConfig) {
    const url = withBase('/deployment.json')
    cachedConfig = fetch(url, { cache: 'no-store' }).then(async (res) => {
      if (!res.ok) {
        throw new Error(`Failed to load ${url} (HTTP ${res.status}). Has \`npm run web:sync-config\` been run?`)
      }
      const config = (await res.json()) as PublicDeploymentConfig
      setLedgerScale(config.assetScale)
      return config
    })
  }
  return cachedConfig
}

/**
 * Whether the published issuance flags set RequireAuth. Undefined when the
 * config predates published flags; the ledger's own flags are the authority
 * wherever a page can read them.
 */
export function configRequiresAuth(config: PublicDeploymentConfig): boolean | undefined {
  return config.flags === undefined ? undefined : (config.flags & LSF_MPT_REQUIRE_AUTH) !== 0
}

export function isIssuerSigner(config: PublicDeploymentConfig, address: string): boolean {
  return config.issuer?.signers.some((signer) => signer.address === address) ?? false
}

export function isGovernanceSigner(config: PublicDeploymentConfig, address: string): boolean {
  return config.governance?.signers.some((signer) => signer.address === address) ?? false
}

export function requireMptIssuanceId(config: PublicDeploymentConfig): string {
  if (!config.mptIssuanceId) {
    throw new Error('No mpt_issuance_id in the published config yet. Run `npm run setup:issuer` and `npm run web:sync-config`.')
  }
  return config.mptIssuanceId
}

export function requireIssuer(config: PublicDeploymentConfig): PublicAccountConfig {
  if (!config.issuer) {
    throw new Error('No issuer in the published config yet. Run `npm run setup:issuer` and `npm run web:sync-config`.')
  }
  return config.issuer
}

export function requireGovernance(config: PublicDeploymentConfig): PublicAccountConfig {
  if (!config.governance) {
    throw new Error('No governance account in the published config yet. Run `npm run setup:governance` and `npm run web:sync-config`.')
  }
  return config.governance
}
