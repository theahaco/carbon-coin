import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Client, RippledError } from 'xrpl'
import { destinationReadinessWarning, getMptHolding, getXrpBalanceDrops } from '../../src/lib/xrplClient'

beforeEach(() => {
  vi.spyOn(Client.prototype, 'connect').mockResolvedValue()
})
afterEach(() => vi.restoreAllMocks())

describe('ledger reads', () => {
  it('distinguishes a missing account from a network failure', async () => {
    const request = vi.spyOn(Client.prototype, 'request')
    request.mockRejectedValueOnce(new RippledError('Not found', { error: 'actNotFound' }))
    expect(await getXrpBalanceDrops('rHolder')).toBeUndefined()
    const failure = new Error('Connection lost')
    request.mockRejectedValueOnce(failure)
    await expect(getXrpBalanceDrops('rHolder')).rejects.toBe(failure)
  })

  it('keeps a readiness lookup failure distinct from a missing holding', async () => {
    const request = vi.spyOn(Client.prototype, 'request')
    request.mockRejectedValueOnce(new RippledError('Not found', { error: 'entryNotFound' }))
    expect(await getMptHolding('rHolder', 'issuance')).toEqual({
      authorized: false,
      balanceRaw: '0',
      locked: false,
    })
    request.mockRejectedValueOnce(new Error('Offline'))
    await expect(destinationReadinessWarning('rSource', 'rHolder', 'issuance')).rejects.toThrow('Offline')
  })
})
