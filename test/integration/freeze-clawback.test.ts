import { localSigners } from '../../src/lib/multisig.js'
import { MPTokenIssuanceSetFlags } from 'xrpl'
import { MPTokenFlags } from 'xrpl'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startLocalNetwork, type LocalNetworkHandle } from '../helpers/localNetwork.js'
import { connectClient, setupAuthorizedHolder, setupIssuer, testEnv } from '../helpers/fixtures.js'

describe('freeze and clawback', () => {
  let network: LocalNetworkHandle

  beforeAll(async () => {
    network = await startLocalNetwork()
  })

  afterAll(async () => {
    await network.teardown()
  })

  it('lets the issuer lock and unlock an individual holder balance', async () => {
    const env = testEnv(network.wsUrl)
    const { client, network: netCfg } = await connectClient(env)
    try {
      const { issuer, mptIssuanceId } = await setupIssuer(client, netCfg, env)
      const holder = await setupAuthorizedHolder(client, netCfg, mptIssuanceId)
      const otherHolder = await setupAuthorizedHolder(client, netCfg, mptIssuanceId)

      await client
        .forAccount(issuer.address)
        .tx.payment({
          Destination: holder.address,
          Amount: { mpt_issuance_id: mptIssuanceId, value: '1000' },
        })
        .multisignAndSubmit(localSigners(issuer.signers, issuer.quorum))

      await client
        .forAccount(issuer.address)
        .tx.mpTokenIssuanceSet({
          MPTokenIssuanceID: mptIssuanceId,
          Flags: MPTokenIssuanceSetFlags.tfMPTLock,
          Holder: holder.address,
        })
        .multisignAndSubmit(localSigners(issuer.signers, issuer.quorum))

      const lockedMpt = await client.command.accountObjects({ account: holder.address, type: 'mptoken' })
      const lockedFlags = lockedMpt.result.account_objects[0]?.Flags ?? 0
      expect(lockedFlags & MPTokenFlags.lsfMPTLocked).not.toBe(0)

      // A locked holder's balance can't be transferred elsewhere. `holder` is a
      // plain (non-multisig) wallet, so it signs with its own regular key.
      const blockedTransferTx = await client
        .forAccount(holder.address)
        .tx.payment({
          Destination: otherHolder.address,
          Amount: { mpt_issuance_id: mptIssuanceId, value: '100' },
        })
        .prepare()
      const signedBlockedTransfer = holder.sign(blockedTransferTx)
      const blockedTransferResult = await client.trySubmitAndWait(signedBlockedTransfer.tx_blob)
      expect(blockedTransferResult.ok).toBe(false)
      if (!blockedTransferResult.ok)
        expect(blockedTransferResult.error).toMatchObject({ engineResult: 'tecLOCKED' })

      await client
        .forAccount(issuer.address)
        .tx.mpTokenIssuanceSet({
          MPTokenIssuanceID: mptIssuanceId,
          Flags: MPTokenIssuanceSetFlags.tfMPTUnlock,
          Holder: holder.address,
        })
        .multisignAndSubmit(localSigners(issuer.signers, issuer.quorum))

      const unlockedMpt = await client.command.accountObjects({ account: holder.address, type: 'mptoken' })
      const unlockedFlags = unlockedMpt.result.account_objects[0]?.Flags ?? 0
      expect(unlockedFlags & MPTokenFlags.lsfMPTLocked).toBe(0)
    } finally {
      await client.disconnect()
    }
  })

  it('lets the issuer claw back tokens from a holder', async () => {
    const env = testEnv(network.wsUrl)
    const { client, network: netCfg } = await connectClient(env)
    try {
      const { issuer, mptIssuanceId } = await setupIssuer(client, netCfg, env)
      const holder = await setupAuthorizedHolder(client, netCfg, mptIssuanceId)

      await client
        .forAccount(issuer.address)
        .tx.payment({
          Destination: holder.address,
          Amount: { mpt_issuance_id: mptIssuanceId, value: '1000' },
        })
        .multisignAndSubmit(localSigners(issuer.signers, issuer.quorum))

      await client
        .forAccount(issuer.address)
        .tx.clawback({ Holder: holder.address, Amount: { mpt_issuance_id: mptIssuanceId, value: '300' } })
        .multisignAndSubmit(localSigners(issuer.signers, issuer.quorum))

      const holderMpt = await client.command.accountObjects({ account: holder.address, type: 'mptoken' })
      expect(holderMpt.result.account_objects[0]?.MPTAmount).toBe('700')

      const issuance = await client.command.ledgerEntry({ mpt_issuance: mptIssuanceId })
      expect(issuance.result.node.OutstandingAmount).toBe('700')
    } finally {
      await client.disconnect()
    }
  })
})
