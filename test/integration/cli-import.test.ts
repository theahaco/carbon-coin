import { afterAll, beforeAll, expect, it } from 'vitest'
import { rmSync, readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { Client, fetchMPTokenOrUndefined } from 'xrpl'
import { startLocalNetwork, type LocalNetworkHandle } from '../helpers/localNetwork.js'
import { setupIssuer, setupGovernance, testEnv } from '../helpers/fixtures.js'
import { cliEnvironment, deployment, token } from '../helpers/cli.js'

let network: LocalNetworkHandle
let client: Client
let directory: string
beforeAll(async () => {
  network = await startLocalNetwork()
  client = new Client(network.wsUrl)
  await client.connect()
})
afterAll(async () => {
  await client?.disconnect()
  await network?.teardown()
  if (directory) rmSync(directory, { recursive: true, force: true })
})

it('imports a deployed legacy quorum, preserves mint history, and signs with the same keys', async () => {
  const net = { name: 'local' as const, wsUrl: network.wsUrl }
  const { issuer, mptIssuanceId } = await setupIssuer(client, net, testEnv(network.wsUrl))
  const governance = await setupGovernance(client, net, mptIssuanceId)
  const context = cliEnvironment({ XRPL_URL: network.rpcUrl })
  directory = context.directory
  const env = context.env
  writeFileSync(env.TOKEN_STATE_FILE!, JSON.stringify({
    network: 'local', issuer, governance, mptIssuanceId, mintedPeriods: ['2025'],
  }))
  await token(env, 'deployment:import')
  const state = deployment(env)
  expect(state.issuer.address).toBe(issuer.address)
  expect(state.governance.address).toBe(governance.address)
  expect(state.mptIssuanceId).toBe(mptIssuanceId)
  expect(state.mintedPeriods).toEqual(['2025'])
  expect(JSON.stringify(state)).not.toContain('"seed"')
  for (const name of readdirSync(env.XRPL_DATA_DIR!, { recursive: true })) {
    if (typeof name !== 'string') continue
    // Metadata records contain public data; ciphertext contains no plaintext seed.
    if (name.endsWith('.toml') || name.endsWith('.age')) {
      const content = readFileSync(env.XRPL_DATA_DIR! + '/' + name, 'utf8')
      expect(content).not.toContain(issuer.seed)
      expect(content).not.toContain(issuer.signers[0]!.seed)
    }
  }
  await token(env, 'deployment:import')
  await expect(token(env, 'mint', '1', '2025')).rejects.toThrow(/already minted/)
  await token(env, 'mint', '10', '2026')
  expect((await fetchMPTokenOrUndefined(client, governance.address, mptIssuanceId, 'validated'))?.MPTAmount).toBe('10')
}, 180_000)
