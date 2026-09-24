import { describe, expect, it } from 'vitest'
import { Client, Wallet, mptToUnits } from 'xrpl'
import { MAX_TOKEN_ASSET_SCALE, issuanceCreateFields, readIssuanceConfig } from '../../src/lib/mpt.js'

describe('issuance config', () => {
  it('defaults to the original open, whole-unit issuance', () => {
    expect(readIssuanceConfig({})).toEqual({ requireAuth: false, assetScale: 0 })
    expect(readIssuanceConfig({ MPT_REQUIRE_AUTH: '', TOKEN_ASSET_SCALE: '' })).toEqual({
      requireAuth: false,
      assetScale: 0,
    })
  })

  it('reads RequireAuth and AssetScale', () => {
    expect(readIssuanceConfig({ MPT_REQUIRE_AUTH: 'true', TOKEN_ASSET_SCALE: '3' })).toEqual({
      requireAuth: true,
      assetScale: 3,
    })
    expect(readIssuanceConfig({ MPT_REQUIRE_AUTH: '1', TOKEN_ASSET_SCALE: '18' })).toEqual({
      requireAuth: true,
      assetScale: 18,
    })
    expect(readIssuanceConfig({ MPT_REQUIRE_AUTH: 'FALSE' }).requireAuth).toBe(false)
  })

  it.each(['-1', '19', '20', '3.5', 'three', '0x3', '1e1'])('rejects TOKEN_ASSET_SCALE=%s', (value) => {
    expect(() => readIssuanceConfig({ TOKEN_ASSET_SCALE: value })).toThrow(/TOKEN_ASSET_SCALE/)
  })

  it('caps AssetScale at the largest scale that still fits one whole unit', () => {
    expect(mptToUnits('1', MAX_TOKEN_ASSET_SCALE)).toBe('1000000000000000000')
    expect(() => mptToUnits('1', MAX_TOKEN_ASSET_SCALE + 1)).toThrow(/maximum MPT amount/)
  })

  it('rejects an unclear MPT_REQUIRE_AUTH', () => {
    expect(() => readIssuanceConfig({ MPT_REQUIRE_AUTH: 'maybe' })).toThrow(/MPT_REQUIRE_AUTH/)
  })

  it('builds the original MPTokenIssuanceCreate by default', () => {
    const fields = issuanceCreateFields({ requireAuth: false, assetScale: 0 }, 'AB')
    expect(fields).toEqual({
      MPTokenMetadata: 'AB',
      Flags: { tfMPTCanTransfer: true, tfMPTCanLock: true, tfMPTCanClawback: true },
    })
    expect(fields).not.toHaveProperty('AssetScale')
  })

  it('adds tfMPTRequireAuth and AssetScale when configured', () => {
    const issuer = Wallet.generate().address
    const tx = new Client('ws://localhost:6006')
      .forAccount(issuer)
      .tx.mpTokenIssuanceCreate(issuanceCreateFields({ requireAuth: true, assetScale: 3 }, 'AB'))
      .toJSON()
    expect(tx.AssetScale).toBe(3)
    expect(tx.Flags).toEqual({
      tfMPTRequireAuth: true,
      tfMPTCanLock: true,
      tfMPTCanTransfer: true,
      tfMPTCanClawback: true,
    })
  })
})
