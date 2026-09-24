import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  Client,
  MPTokenFlags,
  MPTokenIssuanceSetFlags,
  Wallet,
  decodeMemo,
  encodeMemo,
  fetchMPTokenIssuance,
  fetchMPTokenOrUndefined,
  mptToUnits,
} from 'xrpl'
import { localSigners } from '../../src/lib/multisig.js'
import { GOVERNANCE_ADMISSION_MEMO, isMasterKeyDisabled } from '../../src/lib/bootstrap.js'
import type { AccountState, IssuanceState } from '../../src/lib/config.js'
import type { NetworkConfig } from '../../src/lib/network.js'
import { startLocalNetwork, type LocalNetworkHandle } from '../helpers/localNetwork.js'
import {
  connectClient,
  requireAuthEnv,
  setupAuthorizedHolder,
  setupGovernance,
  setupIssuer,
} from '../helpers/fixtures.js'

const KYC_MEMO = { type: 'kyc', data: 'KYC-2026-0001' }

/** Ledger value for a number of displayed units at AssetScale 3. */
const units = (amount: string) => mptToUnits(amount, 3)

/** The memos of a validated transaction, read back from the ledger and decoded. */
async function ledgerMemos(client: Client, hash: string) {
  const tx = await client.command.tx({ transaction: hash })
  return (tx.result.tx_json.Memos ?? []).map((memo) => decodeMemo(memo))
}

async function holderFlags(client: Client, holder: string, mptIssuanceId: string): Promise<number | undefined> {
  return (await fetchMPTokenOrUndefined(client, holder, mptIssuanceId, 'validated'))?.Flags
}

async function balance(client: Client, holder: string, mptIssuanceId: string): Promise<string> {
  return (await fetchMPTokenOrUndefined(client, holder, mptIssuanceId, 'validated'))?.MPTAmount ?? '0'
}

describe('RequireAuth issuance with AssetScale 3', () => {
  let network: LocalNetworkHandle
  let client: Client
  let netCfg: NetworkConfig
  let issuer: AccountState
  let governance: AccountState
  let mptIssuanceId: string
  let recordedIssuance: IssuanceState
  let issuerMasterKeyDisabledBeforeGovernance: boolean

  /** Issuer multisig admission: MPTokenAuthorize with Holder and a memo. */
  async function admit(holder: string, memo = KYC_MEMO) {
    return client
      .forAccount(issuer.address)
      .tx.mpTokenAuthorize({ MPTokenIssuanceID: mptIssuanceId, Holder: holder, Memos: [encodeMemo(memo)] })
      .multisignAndSubmit(localSigners(issuer.signers, issuer.quorum))
  }

  /** Governance multisig delivery of units to a holder. */
  function deliver(destination: string, value: string) {
    return client
      .forAccount(governance.address)
      .tx.payment({ Destination: destination, Amount: { mpt_issuance_id: mptIssuanceId, value } })
  }

  /** Issuer multisig per-holder lock or unlock, with a reason memo. */
  function setLock(holder: string, flag: MPTokenIssuanceSetFlags, reason: string) {
    return client
      .forAccount(issuer.address)
      .tx.mpTokenIssuanceSet({
        MPTokenIssuanceID: mptIssuanceId,
        Holder: holder,
        Flags: flag,
        Memos: [encodeMemo({ type: 'reason', data: reason })],
      })
      .multisignAndSubmit(localSigners(issuer.signers, issuer.quorum))
  }

  /** A holder's own single-sig payment. */
  function holderPays(holder: Wallet, destination: string, value: string) {
    return client
      .withWallet(holder)
      .tx.payment({ Destination: destination, Amount: { mpt_issuance_id: mptIssuanceId, value } })
      .trySignAndSubmit()
  }

  /** A funded wallet that has self-authorized and been admitted by the issuer. */
  async function admittedHolder(): Promise<Wallet> {
    const wallet = await setupAuthorizedHolder(client, netCfg, mptIssuanceId)
    await admit(wallet.address)
    return wallet
  }

  beforeAll(async () => {
    network = await startLocalNetwork()
    const env = requireAuthEnv(network.wsUrl)
    ;({ client, network: netCfg } = await connectClient(env))

    const issued = await setupIssuer(client, netCfg, env)
    issuer = issued.issuer
    mptIssuanceId = issued.mptIssuanceId
    recordedIssuance = issued.issuance
    issuerMasterKeyDisabledBeforeGovernance = await isMasterKeyDisabled(client, issuer.address)

    governance = await setupGovernance(client, netCfg, mptIssuanceId, issuer)

    // One dealing-day issue to the governance account, for the deliveries below.
    await client
      .forAccount(issuer.address)
      .tx.payment({
        Destination: governance.address,
        Amount: { mpt_issuance_id: mptIssuanceId, value: units('100000') },
        Memos: [encodeMemo({ type: 'mint-period', data: '2026-10' })],
      })
      .multisignAndSubmit(localSigners(issuer.signers, issuer.quorum))
  }, 240_000)

  afterAll(async () => {
    await client?.disconnect()
    await network?.teardown()
  })

  it('persists RequireAuth, CanLock, CanTransfer, CanClawback and AssetScale 3 on the issuance', async () => {
    const node = await fetchMPTokenIssuance(client, mptIssuanceId, 'validated')
    // lsfMPTCanLock (2) | lsfMPTRequireAuth (4) | lsfMPTCanTransfer (32) | lsfMPTCanClawback (64) = 102
    expect(node.Flags).toBe(102)
    expect(node.AssetScale).toBe(3)
    expect(node.MaximumAmount).toBeUndefined()
    expect(recordedIssuance).toEqual({ flags: 102, assetScale: 3 })
    expect(node.OutstandingAmount).toBe(units('100000'))
    expect(units('100000')).toBe('100000000')
  })

  it('admits the governance account at bootstrap, before both master keys are disabled', async () => {
    // setup-issuer leaves the issuer's master key enabled on purpose...
    expect(issuerMasterKeyDisabledBeforeGovernance).toBe(false)
    expect(issuer.masterKeyDisablePending).toBe(true)

    // ...so that setup-governance can admit the governance account with it.
    const flags = await holderFlags(client, governance.address, mptIssuanceId)
    expect((flags ?? 0) & MPTokenFlags.lsfMPTAuthorized).not.toBe(0)
    expect(await balance(client, governance.address, mptIssuanceId)).toBe(units('100000'))

    const issuerTxs = await client.command.accountTx({ account: issuer.address, ledger_index_min: -1, ledger_index_max: -1 })
    const admission = issuerTxs.result.transactions
      .map((entry) => entry.tx_json)
      .find((tx) => tx?.TransactionType === 'MPTokenAuthorize' && tx.Holder === governance.address)
    expect(admission).toBeDefined()
    expect((admission?.Memos ?? []).map((memo) => decodeMemo(memo))).toEqual([GOVERNANCE_ADMISSION_MEMO])

    expect(await isMasterKeyDisabled(client, issuer.address)).toBe(true)
    expect(await isMasterKeyDisabled(client, governance.address)).toBe(true)
  })

  it('refuses delivery to a holder that has self-authorized but is not admitted', async () => {
    const pending = await setupAuthorizedHolder(client, netCfg, mptIssuanceId)
    expect(await holderFlags(client, pending.address, mptIssuanceId)).toBe(0)

    const readiness = await client.getMptTransferReadiness({
      account: governance.address,
      destination: pending.address,
      mptIssuanceId,
      amount: units('1'),
    })
    expect(readiness.status).toBe('blocked')

    const fromGovernance = await deliver(pending.address, units('1')).tryMultisignAndSubmit(
      localSigners(governance.signers, governance.quorum),
    )
    expect(fromGovernance.ok).toBe(false)
    if (!fromGovernance.ok) expect(fromGovernance.error).toMatchObject({ engineResult: 'tecNO_AUTH', phase: 'validated' })

    const fromIssuer = await client
      .forAccount(issuer.address)
      .tx.payment({ Destination: pending.address, Amount: { mpt_issuance_id: mptIssuanceId, value: units('1') } })
      .tryMultisignAndSubmit(localSigners(issuer.signers, issuer.quorum))
    expect(fromIssuer.ok).toBe(false)
    if (!fromIssuer.ok) expect(fromIssuer.error).toMatchObject({ engineResult: 'tecNO_AUTH', phase: 'validated' })

    expect(await balance(client, pending.address, mptIssuanceId)).toBe('0')
  })

  it('delivers once the issuer multisig admits the holder with a memo', async () => {
    const holder = await setupAuthorizedHolder(client, netCfg, mptIssuanceId)

    const admission = await admit(holder.address)
    expect(await ledgerMemos(client, admission.result.hash)).toEqual([KYC_MEMO])
    const flags = await holderFlags(client, holder.address, mptIssuanceId)
    expect((flags ?? 0) & MPTokenFlags.lsfMPTAuthorized).not.toBe(0)

    const readiness = await client.getMptTransferReadiness({
      account: governance.address,
      destination: holder.address,
      mptIssuanceId,
      amount: units('1000'),
    })
    expect(readiness.status).toBe('eligible')

    await deliver(holder.address, units('1000')).multisignAndSubmit(localSigners(governance.signers, governance.quorum))
    expect(await balance(client, holder.address, mptIssuanceId)).toBe('1000000')
  })

  it('stops transfers on one holder with a reason memo, and a release restores them', async () => {
    const holder = await admittedHolder()
    const other = await admittedHolder()
    await deliver(holder.address, units('500')).multisignAndSubmit(localSigners(governance.signers, governance.quorum))

    const stop = await setLock(holder.address, MPTokenIssuanceSetFlags.tfMPTLock, 'sanctions review')
    expect(await ledgerMemos(client, stop.result.hash)).toEqual([{ type: 'reason', data: 'sanctions review' }])
    const lockedFlags = (await holderFlags(client, holder.address, mptIssuanceId)) ?? 0
    expect(lockedFlags & MPTokenFlags.lsfMPTLocked).not.toBe(0)
    expect(lockedFlags & MPTokenFlags.lsfMPTAuthorized).not.toBe(0)

    const blocked = await holderPays(holder, other.address, units('10'))
    expect(blocked.ok).toBe(false)
    if (!blocked.ok) expect(blocked.error).toMatchObject({ engineResult: 'tecLOCKED' })

    const release = await setLock(holder.address, MPTokenIssuanceSetFlags.tfMPTUnlock, 'review closed')
    expect(await ledgerMemos(client, release.result.hash)).toEqual([{ type: 'reason', data: 'review closed' }])
    expect(((await holderFlags(client, holder.address, mptIssuanceId)) ?? 0) & MPTokenFlags.lsfMPTLocked).toBe(0)

    const restored = await holderPays(holder, other.address, units('10'))
    expect(restored.ok).toBe(true)
    expect(await balance(client, holder.address, mptIssuanceId)).toBe(units('490'))
    expect(await balance(client, other.address, mptIssuanceId)).toBe(units('10'))
  })

  it('still lets a stopped holder return units to the issuer', async () => {
    // The lock stops transfers between holders only. A locked holder can
    // still send units back to the issuer (which redeems them), so a stop is
    // not a full freeze of the holding.
    const holder = await admittedHolder()
    await deliver(holder.address, units('20')).multisignAndSubmit(localSigners(governance.signers, governance.quorum))
    await setLock(holder.address, MPTokenIssuanceSetFlags.tfMPTLock, 'lost key')

    const redeemed = await holderPays(holder, issuer.address, units('5'))
    expect(redeemed.ok).toBe(true)
    expect(await balance(client, holder.address, mptIssuanceId)).toBe(units('15'))
  })

  it('replaces a lost wallet: claw back from the stopped wallet, then re-issue to an admitted new wallet', async () => {
    const lost = await admittedHolder()
    await deliver(lost.address, units('986')).multisignAndSubmit(localSigners(governance.signers, governance.quorum))
    await setLock(lost.address, MPTokenIssuanceSetFlags.tfMPTLock, 'lost key')

    const before = (await fetchMPTokenIssuance(client, mptIssuanceId, 'validated')).OutstandingAmount
    const replacementMemo = { type: 'reason', data: 'REPL-2026-001 · lost key' }

    const clawback = await client
      .forAccount(issuer.address)
      .tx.clawback({
        Holder: lost.address,
        Amount: { mpt_issuance_id: mptIssuanceId, value: units('986') },
        Memos: [encodeMemo(replacementMemo)],
      })
      .multisignAndSubmit(localSigners(issuer.signers, issuer.quorum))
    expect(await balance(client, lost.address, mptIssuanceId)).toBe('0')
    expect(BigInt((await fetchMPTokenIssuance(client, mptIssuanceId, 'validated')).OutstandingAmount)).toBe(
      BigInt(before) - BigInt(units('986')),
    )

    const replacement = await admittedHolder()
    const reissue = await client
      .forAccount(issuer.address)
      .tx.payment({
        Destination: replacement.address,
        Amount: { mpt_issuance_id: mptIssuanceId, value: units('986') },
        Memos: [encodeMemo(replacementMemo)],
      })
      .multisignAndSubmit(localSigners(issuer.signers, issuer.quorum))

    expect(await balance(client, replacement.address, mptIssuanceId)).toBe(units('986'))
    // The pair leaves the units in issue unchanged.
    expect((await fetchMPTokenIssuance(client, mptIssuanceId, 'validated')).OutstandingAmount).toBe(before)
    expect(await ledgerMemos(client, clawback.result.hash)).toEqual([replacementMemo])
    expect(await ledgerMemos(client, reissue.result.hash)).toEqual([replacementMemo])
  })
})
