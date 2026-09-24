import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { GenericContainer, type StartedTestContainer } from 'testcontainers'
import { Client } from 'xrpl'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const RIPPLED_CFG_PATH = path.resolve(__dirname, '../../devnet/rippled.cfg')
const WS_ADMIN_PORT = 6006

export interface StartedRippledNode {
  /** WebSocket URL of the running stand-alone node. */
  wsUrl: string
  rpcUrl: string
  /** The underlying testcontainers handle, for callers that need to stop it directly. */
  container: StartedTestContainer
}

/** Start an isolated node with dynamically mapped HTTP and WebSocket ports. */
export async function startRippledNode(): Promise<StartedRippledNode> {
  const container = new GenericContainer('rippleci/rippled:latest')
    .withPlatform('linux/amd64')
    .withCommand(['--standalone', '--start', '--conf', '/etc/opt/ripple/rippled.cfg'])
    .withBindMounts([{ source: RIPPLED_CFG_PATH, target: '/etc/opt/ripple/rippled.cfg', mode: 'ro' }])
    .withStartupTimeout(60_000)
    .withExposedPorts(WS_ADMIN_PORT, 5005)

  const started = await container.start()
  const wsUrl = `ws://${started.getHost()}:${started.getMappedPort(WS_ADMIN_PORT)}`
  await waitUntilReady(wsUrl)

  return { wsUrl, rpcUrl: 'http://' + started.getHost() + ':' + started.getMappedPort(5005), container: started }
}

/**
 * `testcontainers`' default "listening port" wait strategy can resolve
 * slightly before rippled's WS/RPC layer is fully able to answer requests.
 * This polls a real `server_info` call until it succeeds.
 */
async function waitUntilReady(wsUrl: string, attempts = 40, delayMs = 500): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const client = new Client(wsUrl)
    try {
      await client.connect()
      await client.command.serverInfo()
      await client.disconnect()
      return
    } catch {
      await client.disconnect().catch(() => {})
      await new Promise((resolve) => setTimeout(resolve, delayMs))
    }
  }
  throw new Error(`Local rippled node at ${wsUrl} did not become ready in time.`)
}
