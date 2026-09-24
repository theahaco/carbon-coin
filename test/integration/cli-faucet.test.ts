import { afterAll, beforeAll, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { readdirSync, rmSync } from 'node:fs'
import { Client, ECDSA, Wallet } from 'xrpl'
import { startLocalNetwork, type LocalNetworkHandle } from '../helpers/localNetwork.js'
import { cliEnvironment, deployment, token } from '../helpers/cli.js'

let network: LocalNetworkHandle
let client: Client
let server: Server
let directory: string
let env: NodeJS.ProcessEnv
let unavailable = true
const requests: string[] = []

beforeAll(async () => {
  network = await startLocalNetwork()
  client = new Client(network.wsUrl)
  await client.connect()
  const genesis = Wallet.fromSeed('snoPBrXtMeMyMHUVTgbuqAfg1SUTb', { algorithm: ECDSA.secp256k1 })
  server = createServer(async (request, response) => {
    try {
      let body = ''
      for await (const chunk of request) body += chunk
      if (request.url === '/accounts') {
        const { destination } = JSON.parse(body)
        requests.push(destination)
        // Enrolment and the deployment checkpoint must precede the faucet call.
        expect(deployment(env).issuer.address).toBe(destination)
        expect(readdirSync(env.XRPL_DATA_DIR! + '/keys').length).toBeGreaterThan(0)
        if (unavailable) {
          response.writeHead(503).end('Temporary faucet failure')
          return
        }
        await client.withWallet(genesis).tx.payment({ Destination: destination, Amount: '1000000000' }).signAndSubmit()
        response.setHeader('Content-Type', 'application/json')
        response.end(JSON.stringify({ account: { address: destination } }))
        return
      }
      // Exercise the actual shared-network branch against a disposable ledger.
      // Only network_id is changed; submissions and validation are real rippled.
      const upstream = await fetch(network.rpcUrl, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body,
      })
      const value = await upstream.json() as { result: { info: { network_id: number } } }
      if (JSON.parse(body).method === 'server_info') value.result.info.network_id = 1
      response.setHeader('Content-Type', 'application/json')
      response.end(JSON.stringify(value))
    } catch (error) {
      response.writeHead(500).end(String(error))
    }
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const binding = server.address()
  if (!binding || typeof binding === 'string') throw new Error('Missing fixture server address')
  const url = 'http://127.0.0.1:' + binding.port
  const context = cliEnvironment({
    XRPL_NETWORK: 'testnet', XRPL_URL: url, XRPL_FAUCET_URL: url + '/accounts',
    ISSUER_SIGNER_ADDRESSES: Array.from({ length: 3 }, () => Wallet.generate().address).join(','),
  })
  directory = context.directory
  env = context.env
})
afterAll(async () => {
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()))
  await client?.disconnect()
  await network?.teardown()
  if (directory) rmSync(directory, { recursive: true, force: true })
})

it('funds an enrolled Testnet address and retries a failed faucet without replacing keys', async () => {
  await expect(token(env, 'setup:issuer')).rejects.toThrow(/503/)
  const firstAddress = deployment(env).issuer.address
  unavailable = false
  await token(env, 'setup:issuer')
  expect(requests).toEqual([firstAddress, firstAddress])
  expect(deployment(env).issuer.address).toBe(firstAddress)
  expect(deployment(env).steps['issuer-ready']).toBe(true)
  await token(env, 'setup:issuer')
  expect(requests).toHaveLength(2)
}, 180_000)
