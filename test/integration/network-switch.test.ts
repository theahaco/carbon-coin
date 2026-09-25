import { describe, expect, it } from 'vitest'
import { resolveNetwork } from '../helpers/sdk/network.js'

describe('network switching', () => {
  it('resolves the local stand-alone endpoint by default', () => {
    const network = resolveNetwork({})
    expect(network.name).toBe('local')
    expect(network.wsUrl).toBe('ws://localhost:6006')
  })

  it('resolves the local stand-alone endpoint explicitly', () => {
    const network = resolveNetwork({ XRPL_NETWORK: 'local' })
    expect(network.name).toBe('local')
    expect(network.wsUrl).toBe('ws://localhost:6006')
  })

  it('resolves the public Testnet endpoint', () => {
    const network = resolveNetwork({ XRPL_NETWORK: 'testnet' })
    expect(network.name).toBe('testnet')
    expect(network.wsUrl).toBe('wss://s.altnet.rippletest.net:51233')
  })

  it('honors an explicit XRPL_WS_URL override for either network', () => {
    const local = resolveNetwork({ XRPL_NETWORK: 'local', XRPL_WS_URL: 'ws://localhost:9999' })
    expect(local.wsUrl).toBe('ws://localhost:9999')

    const testnet = resolveNetwork({ XRPL_NETWORK: 'testnet', XRPL_WS_URL: 'wss://custom.example.com:51233' })
    expect(testnet.wsUrl).toBe('wss://custom.example.com:51233')
  })

  it('rejects an invalid XRPL_NETWORK value', () => {
    expect(() => resolveNetwork({ XRPL_NETWORK: 'mainnet' })).toThrow(/Invalid XRPL_NETWORK/)
  })
})
