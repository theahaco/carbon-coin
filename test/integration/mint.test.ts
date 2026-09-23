import { localSigners } from '../../src/lib/multisig.js'
import { encodeMemo, fetchMPTokenOrUndefined } from 'xrpl'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Wallet, TransactionFailedError } from 'xrpl'
import { fundNewWallet } from '../../src/lib/fund.js'
import { startLocalNetwork, type LocalNetworkHandle } from '../helpers/localNetwork.js'
import { connectClient, setupGovernance, setupIssuer, testEnv } from '../helpers/fixtures.js'

describe('mint', () => {
  let network: LocalNetworkHandle

  beforeAll(async () => {
    network = await startLocalNetwork()
  })

  afterAll(async () => {
    await network.teardown()
  })

  it('succeeds with a 2-of-3 issuer quorum and increases outstanding supply + governance balance', async () => {
    const env = testEnv(network.wsUrl)
    const { client, network: netCfg } = await connectClient(env)
    try {
      const { issuer, mptIssuanceId } = await setupIssuer(client, netCfg, env)
      const governance = await setupGovernance(client, netCfg, mptIssuanceId)

      const paymentTx = client.forAccount(issuer.address).tx.payment({
        Destination: governance.address,
        Amount: { mpt_issuance_id: mptIssuanceId, value: '1000' },
        Memos: [
          encodeMemo({
            type: 'mint-period',
            data: '2026',
          }),
        ],
      })
      const readiness = await client.getMptTransferReadiness({
        account: issuer.address,
        destination: governance.address,
        mptIssuanceId,
        amount: '1000',
      })
      expect(readiness.status).toBe('eligible')
      const result = await paymentTx.multisignAndSubmit(localSigners(issuer.signers, issuer.quorum))
      const history = await client.getMptPaymentHistory(issuer.address, mptIssuanceId)
      expect(history.payments).toHaveLength(1)
      expect(history.payments[0]).toMatchObject({ deliveredAmount: '1000', hash: result.result.hash })

      const issuance = await client.command.ledgerEntry({ mpt_issuance: mptIssuanceId })
      expect(issuance.result.node.OutstandingAmount).toBe('1000')

      const govMpt = await client.command.accountObjects({ account: governance.address, type: 'mptoken' })
      const mptoken = govMpt.result.account_objects[0]
      expect(mptoken?.MPTAmount).toBe('1000')
    } finally {
      await client.disconnect()
    }
  })

  it('is rejected with insufficient signatures (tefBAD_QUORUM)', async () => {
    const env = testEnv(network.wsUrl)
    const { client, network: netCfg } = await connectClient(env)
    try {
      const { issuer, mptIssuanceId } = await setupIssuer(client, netCfg, env)
      const governance = await setupGovernance(client, netCfg, mptIssuanceId)

      const paymentTx = client
        .forAccount(issuer.address)
        .tx.payment({
          Destination: governance.address,
          Amount: { mpt_issuance_id: mptIssuanceId, value: '1' },
        })
      const result = await paymentTx.tryMultisignAndSubmit(localSigners(issuer.signers, 1))
      expect(result.ok).toBe(false)
      // No validated response is fabricated: the preliminary failure survives expiry.
      if (!result.ok) expect(result.error).toMatchObject({ engineResult: 'tefBAD_QUORUM', phase: 'expired' })
    } finally {
      await client.disconnect()
    }
  })

  it('is rejected when signed only by the (disabled) issuer master key', async () => {
    const env = testEnv(network.wsUrl)
    const { client, network: netCfg } = await connectClient(env)
    try {
      const { issuer, mptIssuanceId } = await setupIssuer(client, netCfg, env)
      const governance = await setupGovernance(client, netCfg, mptIssuanceId)

      const issuerWallet = Wallet.fromSeed(issuer.seed)
      const paymentTx = await client
        .forAccount(issuer.address)
        .tx.payment({
          Destination: governance.address,
          Amount: { mpt_issuance_id: mptIssuanceId, value: '1' },
        })
        .prepare()
      const signed = issuerWallet.sign(paymentTx)
      const result = await client.trySubmitAndWait(signed.tx_blob)
      expect(result.ok).toBe(false)
      if (!result.ok)
        expect(result.error).toMatchObject({ engineResult: 'tefMASTER_DISABLED', phase: 'expired' })
    } finally {
      await client.disconnect()
    }
  })

  it('fails cleanly when minting to a destination that has not run MPTokenAuthorize', async () => {
    const env = testEnv(network.wsUrl)
    const { client, network: netCfg } = await connectClient(env)
    try {
      const { issuer, mptIssuanceId } = await setupIssuer(client, netCfg, env)
      const unauthorized = await fundNewWallet(client, netCfg) // funded (exists), but never authorized

      expect(
        await fetchMPTokenOrUndefined(client, unauthorized.address, mptIssuanceId, 'validated'),
      ).toBeUndefined()
      expect(
        (
          await client.getMptTransferReadiness({
            account: issuer.address,
            destination: unauthorized.address,
            mptIssuanceId,
          })
        ).status,
      ).toBe('blocked')
      const paymentTx = client
        .forAccount(issuer.address)
        .tx.payment({
          Destination: unauthorized.address,
          Amount: { mpt_issuance_id: mptIssuanceId, value: '1' },
        })
      const result = await paymentTx.tryMultisignAndSubmit(localSigners(issuer.signers, issuer.quorum))
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(TransactionFailedError)
        expect(result.error).toMatchObject({
          engineResult: 'tecNO_AUTH',
          phase: 'validated',
          response: { result: { validated: true } },
        })
      }
    } finally {
      await client.disconnect()
    }
  })
})
