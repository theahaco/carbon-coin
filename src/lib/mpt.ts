import { unitsToMpt, type MPTokenIssuanceCreateFlagsInterface } from 'xrpl'

/** Shared policy, usable with client.tx.mpTokenIssuanceCreate. */
export const MPT_ISSUANCE_FLAGS = {
  tfMPTCanTransfer: true,
  tfMPTCanLock: true,
  tfMPTCanClawback: true,
}

/**
 * Largest useful `AssetScale`. The ledger field is a UInt8, but an MPT amount
 * is at most 2^63 - 1 (about 9.22 * 10^18 ledger units). At scale 18 one
 * displayed unit is 10^18, so up to 9 whole units fit; at 19 or more, not
 * even one does.
 */
export const MAX_TOKEN_ASSET_SCALE = 18

/** Issuance options that are fixed when the MPT is created (DynamicMPT is off). */
export interface IssuanceConfig {
  /** Sets `tfMPTRequireAuth`: the issuer must admit each holder before it can hold units. */
  requireAuth: boolean
  /** `AssetScale`: one displayed unit is 10^assetScale ledger units. 0 means whole units only. */
  assetScale: number
}

function parseBooleanEnv(name: string, value: string | undefined): boolean {
  const normalized = (value ?? '').trim().toLowerCase()
  if (normalized === '' || normalized === 'false' || normalized === '0' || normalized === 'no') return false
  if (normalized === 'true' || normalized === '1' || normalized === 'yes') return true
  throw new Error(`Invalid ${name} "${value}": expected true or false.`)
}

function parseAssetScaleEnv(value: string | undefined): number {
  const trimmed = (value ?? '').trim()
  if (trimmed === '') return 0
  if (!/^\d+$/.test(trimmed) || Number(trimmed) > MAX_TOKEN_ASSET_SCALE) {
    throw new Error(`Invalid TOKEN_ASSET_SCALE "${value}": expected a whole number from 0 to ${MAX_TOKEN_ASSET_SCALE}.`)
  }
  return Number(trimmed)
}

/**
 * Reads `MPT_REQUIRE_AUTH` (default false) and `TOKEN_ASSET_SCALE` (default 0).
 * Leaving both unset gives the original issuance: open holding, whole units.
 */
export function readIssuanceConfig(env: NodeJS.ProcessEnv = process.env): IssuanceConfig {
  return {
    requireAuth: parseBooleanEnv('MPT_REQUIRE_AUTH', env.MPT_REQUIRE_AUTH),
    assetScale: parseAssetScaleEnv(env.TOKEN_ASSET_SCALE),
  }
}

/**
 * The `MPTokenIssuanceCreate` fields for a given config. `AssetScale` is only
 * sent when it's above 0, and `tfMPTRequireAuth` only when enabled, so the
 * default config builds exactly the original transaction.
 */
export function issuanceCreateFields(
  config: IssuanceConfig,
  metadataHex: string,
): { MPTokenMetadata: string; Flags: MPTokenIssuanceCreateFlagsInterface; AssetScale?: number } {
  return {
    MPTokenMetadata: metadataHex,
    Flags: config.requireAuth ? { ...MPT_ISSUANCE_FLAGS, tfMPTRequireAuth: true } : { ...MPT_ISSUANCE_FLAGS },
    ...(config.assetScale > 0 ? { AssetScale: config.assetScale } : {}),
  }
}

/**
 * A ledger amount (integer `value`) for CLI output. With AssetScale 0 that's
 * the plain count; otherwise the displayed units are shown too.
 */
export function describeLedgerAmount(raw: string, assetScale = 0): string {
  if (assetScale === 0) return `${raw} unit(s)`
  return `${raw} ledger unit(s) (${unitsToMpt(raw, assetScale)} at AssetScale ${assetScale})`
}
