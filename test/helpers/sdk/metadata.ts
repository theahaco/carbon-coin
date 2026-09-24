import { encodeMPTokenMetadata } from 'xrpl'
import { config as loadDotenv } from 'dotenv'

// Ensure .env is loaded even if this module is imported before config.ts.
loadDotenv()

export interface TokenMetadataConfig {
  ticker: string
  name: string
  description?: string
  icon: string
  assetClass: string
  assetSubclass: string
  issuerName: string
}

export function readTokenMetadataConfig(env: NodeJS.ProcessEnv = process.env): TokenMetadataConfig {
  const ticker = env.TOKEN_TICKER
  const name = env.TOKEN_NAME
  const icon = env.TOKEN_ICON_URL
  const assetClass = env.TOKEN_ASSET_CLASS
  const assetSubclass = env.TOKEN_ASSET_SUBCLASS
  const issuerName = env.TOKEN_ISSUER_NAME

  const missing = Object.entries({ TOKEN_TICKER: ticker, TOKEN_NAME: name, TOKEN_ICON_URL: icon, TOKEN_ASSET_CLASS: assetClass, TOKEN_ISSUER_NAME: issuerName })
    .filter(([, value]) => !value)
    .map(([key]) => key)
  if (missing.length > 0) {
    throw new Error(`Missing required token identity env var(s): ${missing.join(', ')}. See .env.example.`)
  }

  return {
    ticker: ticker as string,
    name: name as string,
    description: env.TOKEN_DESCRIPTION,
    icon: icon as string,
    assetClass: assetClass as string,
    assetSubclass: assetSubclass as string,
    issuerName: issuerName as string,
  }
}

/**
 * Builds and hex-encodes the XLS-89 MPTokenMetadata blob from the token
 * identity configured via TOKEN_* env vars. Kept separate from mpt.ts's
 * transaction builders since this only concerns display/identity metadata,
 * not issuance mechanics.
 */
export function buildMptMetadataHex(config: TokenMetadataConfig): string {
  return encodeMPTokenMetadata({
    ticker: config.ticker,
    name: config.name,
    desc: config.description,
    icon: config.icon,
    asset_class: config.assetClass,
    asset_subclass: config.assetSubclass,
    issuer_name: config.issuerName,
  })
}
