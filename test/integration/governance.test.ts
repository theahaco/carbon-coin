import { localSigners } from '../../src/lib/multisig.js'
import { fetchMPTokenOrUndefined } from 'xrpl'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startLocalNetwork, type LocalNetworkHandle } from '../helpers/localNetwork.js'
import {
  connectClient,
  setupAuthorizedHolder,
  setupGovernance,
  setupIssuer,
  testEnv,
} from '../helpers/fixtures.js'

describe('governance', () => {
  let network: LocalNetworkHandle

  beforeAll(async () => {
    network = await startLocalNetwork()
  })

  afterAll(async () => {
    await network.teardown()
  })

  it('is set up with a 2-of-3 SignerList, a disabled master key, and successful MPTokenAuthorize', async () => {
    const env = testEnv(network.wsUrl)
    const { client, network: netCfg } = await connectClient(env)
    try {
      const { mptIssuanceId } = await setupIssuer(client, netCfg, env)
      const governance = await setupGovernance(client, netCfg, mptIssuanceId)

      const signerLists = await client.command.accountObjects({
        account: governance.address,
        type: 'signer_list',
      })
      const signerList = signerLists.result.account_objects[0]
      expect(signerList?.SignerQuorum).toBe(2)
      expect(signerList?.SignerEntries).toHaveLength(3)

      const accountInfo = await client.command.accountInfo({ account: governance.address })
      expect(accountInfo.result.account_flags?.disableMasterKey).toBe(true)

      const mptObjects = await client.command.accountObjects({ account: governance.address, type: 'mptoken' })
      expect(mptObjects.result.account_objects).toHaveLength(1)
      const holding = await fetchMPTokenOrUndefined(client, governance.address, mptIssuanceId, 'validated')
      expect(holding).toBeDefined()
      expect(holding?.MPTAmount ?? '0').toBe('0')
    } finally {
      await client.disconnect()
    }
  })

  it('can redistribute a balance to an authorized recipient via 2-of-3 multisig', async () => {
    const env = testEnv(network.wsUrl)
    const { client, network: netCfg } = await connectClient(env)
    try {
      const { issuer, mptIssuanceId } = await setupIssuer(client, netCfg, env)
      const governance = await setupGovernance(client, netCfg, mptIssuanceId)
      const recipient = await setupAuthorizedHolder(client, netCfg, mptIssuanceId)

      await client
        .forAccount(issuer.address)
        .tx.payment({
          Destination: governance.address,
          Amount: { mpt_issuance_id: mptIssuanceId, value: '1000' },
        })
        .multisignAndSubmit(localSigners(issuer.signers, issuer.quorum))

      await client
        .forAccount(governance.address)
        .tx.payment({
          Destination: recipient.address,
          Amount: { mpt_issuance_id: mptIssuanceId, value: '400' },
        })
        .multisignAndSubmit(localSigners(governance.signers, governance.quorum))

      const recipientMpt = await fetchMPTokenOrUndefined(
        client,
        recipient.address,
        mptIssuanceId,
        'validated',
      )
      expect(recipientMpt?.MPTAmount).toBe('400')

      const governanceMpt = await fetchMPTokenOrUndefined(
        client,
        governance.address,
        mptIssuanceId,
        'validated',
      )
      expect(governanceMpt?.MPTAmount).toBe('600')
    } finally {
      await client.disconnect()
    }
  })
})
