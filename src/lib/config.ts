import { config as loadDotenv } from 'dotenv'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

// Load .env once, as early as possible, for any script/module that imports
// this file. Safe to call multiple times; dotenv no-ops if already loaded.
loadDotenv()

export interface SignerWallet {
  address: string
  seed: string
}

export interface AccountState {
  address: string
  /** Master seed. Kept for local reference only; the master key is disabled
   * once the account's bootstrap steps are done, so this seed cannot sign
   * anything for the account going forward (mint/lock/clawback/etc. all
   * require the signer quorum below). */
  seed: string
  signers: SignerWallet[]
  quorum: number
  /** True while the master key is still enabled on purpose because setup
   * isn't finished. With RequireAuth, the issuer keeps it until
   * `setup:governance` has admitted the governance account. Absent in state
   * files written before this field existed, which means "disabled". */
  masterKeyDisablePending?: boolean
}

/** Issuance settings read back from the ledger after MPTokenIssuanceCreate. */
export interface IssuanceState {
  /** The MPTokenIssuance `Flags` (lsfMPT* bits) when read. All are fixed at
   * creation except lsfMPTLocked, which the issuer multisig can change, so
   * that bit is only a snapshot. */
  flags: number
  /** The MPTokenIssuance `AssetScale` (0 when the field is absent). */
  assetScale: number
}

export interface DeploymentState {
  network: string
  issuer?: AccountState
  governance?: AccountState
  mptIssuanceId?: string
  issuance?: IssuanceState
  /** Issuance periods (e.g. years) that have already been minted, to guard
   * against accidental double-minting. */
  mintedPeriods?: string[]
}

const DEPLOYMENT_FILE = path.resolve(process.cwd(), '.deployment.json')

export function loadDeploymentState(): DeploymentState {
  if (!existsSync(DEPLOYMENT_FILE)) {
    return { network: process.env.XRPL_NETWORK ?? 'local' }
  }
  const raw = readFileSync(DEPLOYMENT_FILE, 'utf-8')
  return JSON.parse(raw) as DeploymentState
}

export function saveDeploymentState(state: DeploymentState): void {
  writeFileSync(DEPLOYMENT_FILE, JSON.stringify(state, null, 2) + '\n', 'utf-8')
}

export function requireIssuer(state: DeploymentState): AccountState {
  if (!state.issuer) {
    throw new Error('No issuer found in .deployment.json. Run `npm run setup:issuer` first.')
  }
  return state.issuer
}

export function requireGovernance(state: DeploymentState): AccountState {
  if (!state.governance) {
    throw new Error('No governance account found in .deployment.json. Run `npm run setup:governance` first.')
  }
  return state.governance
}

export function requireMptIssuanceId(state: DeploymentState): string {
  if (!state.mptIssuanceId) {
    throw new Error('No mpt_issuance_id found in .deployment.json. Run `npm run setup:issuer` first.')
  }
  return state.mptIssuanceId
}
