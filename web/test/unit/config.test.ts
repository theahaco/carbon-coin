import { afterEach, describe, expect, it, vi } from 'vitest'
import { LEGACY_LEDGER_SCALE } from '../../src/lib/units'

afterEach(() => {
  vi.restoreAllMocks()
  vi.resetModules()
})

async function loadWith(json: Record<string, unknown>) {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify(json), { status: 200 }))
  // A fresh module: config.ts caches the fetched config for the page's lifetime.
  const config = await import('../../src/lib/config')
  const units = await import('../../src/lib/units')
  return { loaded: await config.loadPublicConfig(), config, units }
}

const base = { network: 'testnet', token: { ticker: 'HQUAY', name: 'n', icon: 'i', issuerName: 'x' } }

describe('deployment.json issuance settings', () => {
  it('sets the units scale from assetScale when the config loads', async () => {
    const { units } = await loadWith({ ...base, assetScale: 3, flags: 102 })
    expect(units.getLedgerScale()).toBe(3)
    expect(units.formatUnits('1000000')).toBe('1,000.000')
  })

  it('keeps the legacy scale for a Phase 1 config without assetScale', async () => {
    const { units } = await loadWith(base)
    expect(units.getLedgerScale()).toBe(LEGACY_LEDGER_SCALE)
    expect(units.formatUnits('235187958000000')).toBe('235,187.958')
  })

  it('reads RequireAuth from the published flags, and says nothing without them', async () => {
    const { config, loaded } = await loadWith({ ...base, flags: 102 })
    expect(config.configRequiresAuth(loaded)).toBe(true)
    expect(config.configRequiresAuth({ ...loaded, flags: 0x62 })).toBe(false)
    expect(config.configRequiresAuth({ ...loaded, flags: undefined })).toBeUndefined()
  })
})
