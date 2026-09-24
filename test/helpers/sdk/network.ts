import { config as loadDotenv } from 'dotenv'

// Ensure .env is loaded even if this module is imported before config.ts.
loadDotenv()

export type NetworkName = 'local' | 'testnet'

export interface NetworkConfig {
  name: NetworkName
  wsUrl: string
}

const DEFAULT_WS_URLS: Record<NetworkName, string> = {
  local: 'ws://localhost:6006',
  testnet: 'wss://s.altnet.rippletest.net:51233',
}

/**
 * The well-known stand-alone-mode genesis account. Its keys are published by
 * Ripple as part of the rippled/xrpld documentation and are only usable
 * against a fresh, local, disposable stand-alone node -- never mainnet or a
 * shared network.
 */
export const STANDALONE_GENESIS_ACCOUNT = {
  address: 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh',
  secret: 'snoPBrXtMeMyMHUVTgbuqAfg1SUTb',
}

function parseNetworkName(value: string | undefined): NetworkName {
  if (value === 'local' || value === 'testnet') {
    return value
  }
  if (value === undefined || value === '') {
    return 'local'
  }
  throw new Error(`Invalid XRPL_NETWORK "${value}": expected "local" or "testnet".`)
}

/**
 * Resolves the active network from environment variables. This is the single
 * place that decides which XRPL endpoint scripts/tests talk to, so switching
 * from local development to Testnet is purely a .env change.
 */
export function resolveNetwork(env: NodeJS.ProcessEnv = process.env): NetworkConfig {
  const name = parseNetworkName(env.XRPL_NETWORK)
  const wsUrl = env.XRPL_WS_URL && env.XRPL_WS_URL.trim() !== '' ? env.XRPL_WS_URL : DEFAULT_WS_URLS[name]
  return { name, wsUrl }
}
