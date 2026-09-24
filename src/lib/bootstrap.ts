import {
  AccountSetAsfFlags,
  MPTokenFlags,
  MPTokenIssuanceFlags,
  Wallet,
  encodeMemo,
  fetchMPTokenIssuance,
  fetchMPTokenOrUndefined,
  type Client,
  type WalletContext,
} from 'xrpl'
import type { AccountState, IssuanceState, SignerWallet } from './config.js'
import { issuanceCreateFields, type IssuanceConfig } from './mpt.js'
import { signerListFields } from './multisig.js'

// One-time bootstrap steps for the issuer and governance accounts, signed
// single-sig with each account's still-active master key. Each step reads
// the validated ledger first and does nothing when its effect is already
// there, so a setup script that stopped half-way can simply be rerun.

export type Log = (message: string) => void

const silent: Log = () => {}

/** Memo on the issuer's bootstrap admission of the governance account (RequireAuth only). */
export const GOVERNANCE_ADMISSION_MEMO = { type: 'admission', data: 'bootstrap: governance account' }

/** The master-key wallet for an account in .deployment.json. */
export function masterWallet(account: AccountState): Wallet {
  const wallet = Wallet.fromSeed(account.seed)
  if (wallet.address !== account.address) {
    throw new Error(`The seed stored for ${account.address} derives ${wallet.address}. Check .deployment.json.`)
  }
  return wallet
}

/** The issuance's flags and scale, read from the validated ledger. */
export async function readIssuance(client: Client, mptIssuanceId: string): Promise<IssuanceState> {
  const node = await fetchMPTokenIssuance(client, mptIssuanceId, 'validated')
  return { flags: node.Flags, assetScale: node.AssetScale ?? 0 }
}

export function issuanceRequiresAuth(issuance: IssuanceState): boolean {
  return (issuance.flags & MPTokenIssuanceFlags.lsfMPTRequireAuth) !== 0
}

/** MPT issuances the account has created (and not destroyed). */
export async function findIssuanceIds(client: Client, issuer: string): Promise<string[]> {
  const response = await client.command.accountObjects({
    account: issuer,
    type: 'mpt_issuance',
    ledger_index: 'validated',
  })
  return response.result.account_objects.map((issuance) => issuance.mpt_issuance_id)
}

export async function isMasterKeyDisabled(client: Client, address: string): Promise<boolean> {
  const info = await client.command.accountInfo({ account: address, ledger_index: 'validated' })
  return info.result.account_flags?.disableMasterKey ?? false
}

async function readSignerList(client: Client, address: string) {
  const response = await client.command.accountObjects({
    account: address,
    type: 'signer_list',
    ledger_index: 'validated',
  })
  return response.result.account_objects[0]
}

/**
 * Sets the equal-weight signer list unless it's already on the ledger.
 * Refuses to continue if a different list is there.
 *
 * @returns Whether a SignerListSet was submitted.
 */
export async function ensureSignerList(
  client: Client,
  account: WalletContext,
  signers: SignerWallet[],
  quorum: number,
): Promise<boolean> {
  const fields = signerListFields(signers, quorum)
  const existing = await readSignerList(client, account.address)
  if (existing) {
    const onLedger = (existing.SignerEntries ?? []).map((entry) => entry.SignerEntry.Account).sort()
    const expected = signers.map(({ address }) => address).sort()
    if (existing.SignerQuorum !== quorum || onLedger.join(',') !== expected.join(',')) {
      throw new Error(
        `${account.address} already has a different signer list on the ledger (quorum ${existing.SignerQuorum} of ${onLedger.join(', ')}). ` +
          'Check .deployment.json before continuing.',
      )
    }
    return false
  }
  await account.tx.signerListSet(fields).signAndSubmit()
  return true
}

/**
 * Disables the master key unless it already is. Refuses when the account has
 * no signer list, since the account could then never sign again.
 *
 * @returns Whether an AccountSet was submitted.
 */
export async function ensureMasterKeyDisabled(client: Client, account: WalletContext): Promise<boolean> {
  if (await isMasterKeyDisabled(client, account.address)) return false
  if (!(await readSignerList(client, account.address))) {
    throw new Error(`Refusing to disable the master key of ${account.address}: it has no signer list yet.`)
  }
  await account.tx.accountSet({ SetFlag: AccountSetAsfFlags.asfDisableMaster }).signAndSubmit()
  return true
}

/**
 * The holder's own MPTokenAuthorize, which creates its MPToken. Skipped when
 * the MPToken already exists.
 *
 * @returns Whether an MPTokenAuthorize was submitted.
 */
export async function ensureSelfAuthorized(
  client: Client,
  holder: WalletContext,
  mptIssuanceId: string,
): Promise<boolean> {
  if (await fetchMPTokenOrUndefined(client, holder.address, mptIssuanceId, 'validated')) return false
  await holder.tx.mpTokenAuthorize({ MPTokenIssuanceID: mptIssuanceId }).signAndSubmit()
  return true
}

/** Whether the issuer has admitted the holder (`lsfMPTAuthorized` on its MPToken). */
export async function isHolderAdmitted(client: Client, holder: string, mptIssuanceId: string): Promise<boolean> {
  const mptoken = await fetchMPTokenOrUndefined(client, holder, mptIssuanceId, 'validated')
  return mptoken !== undefined && (mptoken.Flags & MPTokenFlags.lsfMPTAuthorized) !== 0
}

/**
 * The issuer's MPTokenAuthorize with `Holder`, signed with the issuer's
 * master key during bootstrap. Skipped when the holder is already admitted.
 *
 * @returns Whether an MPTokenAuthorize was submitted.
 */
export async function ensureAdmittedWithMasterKey(
  client: Client,
  issuer: WalletContext,
  mptIssuanceId: string,
  holder: string,
  memo: { type: string; data: string },
): Promise<boolean> {
  if (await isHolderAdmitted(client, holder, mptIssuanceId)) return false
  if (await isMasterKeyDisabled(client, issuer.address)) {
    throw new Error(
      `${holder} isn't admitted yet, and the issuer's master key is already disabled, so bootstrap can't sign the admission. ` +
        'Admit it with the issuer multisig instead.',
    )
  }
  await issuer.tx
    .mpTokenAuthorize({ MPTokenIssuanceID: mptIssuanceId, Holder: holder, Memos: [encodeMemo(memo)] })
    .signAndSubmit()
  return true
}

export interface IssuerBootstrapParams {
  signers: SignerWallet[]
  quorum: number
  config: IssuanceConfig
  metadataHex: string
  /** Known from .deployment.json when resuming. */
  mptIssuanceId?: string
  /** Called once the issuance ID is known, so the caller can save it before the next step. */
  onIssuanceId?: (mptIssuanceId: string) => void
  log?: Log
}

export interface IssuerBootstrapResult {
  mptIssuanceId: string
  issuance: IssuanceState
  /** True when the master key was left enabled for `setup:governance` (RequireAuth). */
  masterKeyDisablePending: boolean
}

/**
 * Issuer bootstrap: create the issuance (single-sig), set the signer list,
 * then disable the master key. With RequireAuth, the master key stays
 * enabled so that `bootstrapGovernance` can admit the governance account;
 * that step disables it afterwards.
 */
export async function bootstrapIssuer(
  client: Client,
  issuerWallet: Wallet,
  params: IssuerBootstrapParams,
): Promise<IssuerBootstrapResult> {
  const log = params.log ?? silent
  const issuer = client.withWallet(issuerWallet)

  let mptIssuanceId = params.mptIssuanceId
  if (!mptIssuanceId) {
    const existing = await findIssuanceIds(client, issuer.address)
    if (existing.length > 1) {
      throw new Error(`${issuer.address} already has ${existing.length} MPT issuances. Record the right one in .deployment.json.`)
    }
    if (existing[0]) {
      mptIssuanceId = existing[0]
      log(`Found the existing MPT issuance ${mptIssuanceId}; not creating another.`)
    } else {
      const issued = await issuer.tx
        .mpTokenIssuanceCreate(issuanceCreateFields(params.config, params.metadataHex))
        .signAndSubmit()
      mptIssuanceId = issued.result.meta.mpt_issuance_id
      if (!mptIssuanceId) throw new Error('MPTokenIssuanceCreate succeeded but no mpt_issuance_id was returned.')
      log(`Created MPT issuance: ${mptIssuanceId}`)
    }
    params.onIssuanceId?.(mptIssuanceId)
  }

  // Flags and scale are fixed at creation, so the ledger decides the rest of
  // the setup order, not the current env.
  const issuance = await readIssuance(client, mptIssuanceId)
  const requireAuth = issuanceRequiresAuth(issuance)
  if (requireAuth !== params.config.requireAuth || issuance.assetScale !== params.config.assetScale) {
    log(
      `Warning: the issuance on the ledger has RequireAuth ${requireAuth ? 'on' : 'off'} and AssetScale ${issuance.assetScale}, ` +
        `but MPT_REQUIRE_AUTH/TOKEN_ASSET_SCALE ask for ${params.config.requireAuth ? 'on' : 'off'} and ${params.config.assetScale}. ` +
        'Issuance settings are fixed at creation; continuing with the ledger values.',
    )
  }

  if (await ensureSignerList(client, issuer, params.signers, params.quorum)) {
    log(`Configured the issuer's ${params.quorum}-of-${params.signers.length} multisig.`)
  }

  if (requireAuth) {
    const disabled = await isMasterKeyDisabled(client, issuer.address)
    if (!disabled) {
      log(
        "RequireAuth is on: the issuer's master key stays enabled until `npm run setup:governance` has admitted the governance account.",
      )
    }
    return { mptIssuanceId, issuance, masterKeyDisablePending: !disabled }
  }

  if (await ensureMasterKeyDisabled(client, issuer)) log("Disabled the issuer's master key.")
  return { mptIssuanceId, issuance, masterKeyDisablePending: false }
}

export interface GovernanceBootstrapParams {
  signers: SignerWallet[]
  quorum: number
  mptIssuanceId: string
  /** The issuer's master-key wallet. Only used, and then required, when the issuance has RequireAuth. */
  issuerWallet?: Wallet
  log?: Log
}

/**
 * Governance bootstrap: self-authorize to hold the MPT (single-sig). With
 * RequireAuth, the issuer then admits the governance account with its master
 * key and disables that key. Last, the governance signer list is set and its
 * master key disabled.
 *
 * @returns Whether the issuance has RequireAuth (and so whether the admission step ran).
 */
export async function bootstrapGovernance(
  client: Client,
  governanceWallet: Wallet,
  params: GovernanceBootstrapParams,
): Promise<{ requireAuth: boolean }> {
  const log = params.log ?? silent
  const governance = client.withWallet(governanceWallet)
  const requireAuth = issuanceRequiresAuth(await readIssuance(client, params.mptIssuanceId))

  // A governance account whose master key is already disabled can't sign its
  // own MPTokenAuthorize, which happens when it was set up for an earlier
  // issuance. Stop before anything is submitted, and say what's still open.
  const holding = await fetchMPTokenOrUndefined(client, governance.address, params.mptIssuanceId, 'validated')
  if (!holding && (await isMasterKeyDisabled(client, governance.address))) {
    const issuerAddress = requireAuth ? params.issuerWallet?.address : undefined
    const issuerKeyEnabled = issuerAddress !== undefined && !(await isMasterKeyDisabled(client, issuerAddress))
    throw new Error(
      `The governance account ${governance.address} holds no MPToken for ${params.mptIssuanceId}, and its master key is already disabled, ` +
        "so bootstrap can't sign its MPTokenAuthorize. It was probably set up for an earlier issuance. " +
        (issuerKeyEnabled
          ? `The issuer's master key (${issuerAddress}) is still enabled: it's only disabled once the governance account is admitted. `
          : '') +
        'To recover, either delete the "governance" field from .deployment.json and rerun `npm run setup:governance` to set up a new governance account, ' +
        'or submit an MPTokenAuthorize for this issuance from the governance multisig and then rerun `npm run setup:governance`.',
    )
  }

  if (await ensureSelfAuthorized(client, governance, params.mptIssuanceId)) {
    log('Governance account authorized to hold the MPT.')
  }

  if (requireAuth) {
    if (!params.issuerWallet) {
      throw new Error("The issuance has RequireAuth, so the issuer's master key is needed to admit the governance account.")
    }
    const issuer = client.withWallet(params.issuerWallet)
    if (
      await ensureAdmittedWithMasterKey(
        client,
        issuer,
        params.mptIssuanceId,
        governance.address,
        GOVERNANCE_ADMISSION_MEMO,
      )
    ) {
      log('The issuer admitted the governance account (MPTokenAuthorize with Holder).')
    }
    if (await ensureMasterKeyDisabled(client, issuer)) log("Disabled the issuer's master key.")
  }

  if (await ensureSignerList(client, governance, params.signers, params.quorum)) {
    log(`Configured the governance account's ${params.quorum}-of-${params.signers.length} multisig.`)
  }
  if (await ensureMasterKeyDisabled(client, governance)) log("Disabled the governance account's master key.")
  return { requireAuth }
}
