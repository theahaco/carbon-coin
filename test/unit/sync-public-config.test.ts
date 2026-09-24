import { describe, expect, it } from 'vitest'
import { assertNoSeedKey, buildPublicConfig } from '../../src/scripts/sync-public-config.js'
import type { DeploymentState } from '../../src/lib/config.js'
import type { TokenMetadataConfig } from '../../src/lib/metadata.js'

const tokenConfig: TokenMetadataConfig = {
  ticker: 'CRBN',
  name: 'Carbon Coin',
  description: 'Aligning Long-Term Wealth with Planetary Decarbonization',
  icon: 'https://example.org/icon.png',
  assetClass: 'other',
  assetSubclass: 'other',
  issuerName: 'UN Ministry For The Future',
}

const state: DeploymentState = {
  network: 'testnet',
  mptIssuanceId: 'ABCDEF0123456789',
  // RequireAuth | CanLock | CanTransfer | CanClawback
  issuance: { flags: 102, assetScale: 3 },
  issuer: {
    address: 'rIssuerAddress',
    seed: 'sIssuerSeedSecret',
    quorum: 2,
    signers: [
      { address: 'rSignerOne', seed: 'sSignerOneSeedSecret' },
      { address: 'rSignerTwo', seed: '' },
      { address: 'rSignerThree', seed: 'sSignerThreeSeedSecret' },
    ],
  },
  governance: {
    address: 'rGovernanceAddress',
    seed: 'sGovernanceSeedSecret',
    quorum: 2,
    signers: [
      { address: 'rGovSignerOne', seed: 'sGovSignerOneSeedSecret' },
      { address: 'rGovSignerTwo', seed: 'sGovSignerTwoSeedSecret' },
    ],
  },
}

describe('sync-public-config', () => {
  it('carries over only non-secret fields', () => {
    const publicConfig = buildPublicConfig(state, tokenConfig)

    expect(publicConfig).toEqual({
      network: 'testnet',
      mptIssuanceId: 'ABCDEF0123456789',
      assetScale: 3,
      flags: 102,
      token: {
        ticker: 'CRBN',
        name: 'Carbon Coin',
        description: 'Aligning Long-Term Wealth with Planetary Decarbonization',
        icon: 'https://example.org/icon.png',
        issuerName: 'UN Ministry For The Future',
      },
      issuer: {
        address: 'rIssuerAddress',
        quorum: 2,
        signers: [{ address: 'rSignerOne' }, { address: 'rSignerTwo' }, { address: 'rSignerThree' }],
      },
      governance: {
        address: 'rGovernanceAddress',
        quorum: 2,
        signers: [{ address: 'rGovSignerOne' }, { address: 'rGovSignerTwo' }],
      },
    })
  })

  it('never serializes a "seed" key, even though the input state is full of them', () => {
    const publicConfig = buildPublicConfig(state, tokenConfig)
    const serialized = JSON.stringify(publicConfig, null, 2)

    expect(serialized).not.toMatch(/"seed"\s*:/)
    expect(serialized).not.toContain('SeedSecret')
    expect(() => assertNoSeedKey(serialized)).not.toThrow()
  })

  it('assertNoSeedKey rejects output that does contain a seed key', () => {
    expect(() => assertNoSeedKey(JSON.stringify({ seed: 'sSomethingSecret' }))).toThrow(/seed/)
  })

  it('handles missing issuer/governance gracefully', () => {
    const publicConfig = buildPublicConfig({ network: 'testnet' }, tokenConfig)
    expect(publicConfig.issuer).toBeUndefined()
    expect(publicConfig.governance).toBeUndefined()
    expect(publicConfig.mptIssuanceId).toBeUndefined()
  })

  it('publishes a whole-unit, open issuance as AssetScale 0 and its flags', () => {
    const publicConfig = buildPublicConfig({ ...state, issuance: { flags: 98, assetScale: 0 } }, tokenConfig)
    expect(publicConfig).toMatchObject({ assetScale: 0, flags: 98 })
  })

  it('never publishes the lock bit, which can change after the snapshot', () => {
    // lsfMPTLocked (0x01) on top of RequireAuth | CanLock | CanTransfer | CanClawback
    const publicConfig = buildPublicConfig({ ...state, issuance: { flags: 103, assetScale: 3 } }, tokenConfig)
    expect(publicConfig.flags).toBe(102)
  })

  it('leaves assetScale and flags out for a state written before they were recorded', () => {
    const { issuance: _omitted, ...olderState } = state
    const serialized = JSON.stringify(buildPublicConfig(olderState, tokenConfig))
    expect(serialized).not.toContain('"assetScale"')
    expect(serialized).not.toContain('"flags"')
  })
})
