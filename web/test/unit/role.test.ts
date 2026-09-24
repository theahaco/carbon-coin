import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Client } from 'xrpl'
import { holderRole, ROLE_LABEL, ROLE_WITH_ARTICLE } from '../../src/lib/role'
import { getMptHolding } from '../../src/lib/xrplClient'

beforeEach(() => {
  vi.spyOn(Client.prototype, 'connect').mockResolvedValue()
})
afterEach(() => vi.restoreAllMocks())

function mptoken(flags: number, amount = '0') {
  vi.spyOn(Client.prototype, 'request').mockResolvedValueOnce({ result: { node: { Flags: flags, MPTAmount: amount } } } as never)
}

describe('holding status from the MPToken flags', () => {
  it('reads admission (lsfMPTAuthorized 0x2) and the lock (lsfMPTLocked 0x1) separately', async () => {
    mptoken(0)
    expect(await getMptHolding('rPending', 'issuance')).toEqual({ hasHolding: true, admitted: false, balanceRaw: '0', locked: false })
    mptoken(2, '25000000')
    expect(await getMptHolding('rInvestor', 'issuance')).toEqual({ hasHolding: true, admitted: true, balanceRaw: '25000000', locked: false })
    mptoken(3, '12500000')
    expect(await getMptHolding('rLocked', 'issuance')).toEqual({ hasHolding: true, admitted: true, balanceRaw: '12500000', locked: true })
  })
})

describe('holder roles', () => {
  const none = { hasHolding: false, admitted: false, locked: false }
  const requested = { hasHolding: true, admitted: false, locked: false }
  const admitted = { hasHolding: true, admitted: true, locked: false }
  const locked = { hasHolding: true, admitted: true, locked: true }

  it('is pending under RequireAuth until the Register admits the account, asked or not', () => {
    expect(holderRole(none, true)).toBe('pending')
    expect(holderRole(requested, true)).toBe('pending')
    expect(holderRole(admitted, true)).toBe('investor')
    expect(holderRole(locked, true)).toBe('locked')
    // A locked holding that was never admitted still can't hold units: pending comes first.
    expect(holderRole({ ...requested, locked: true }, true)).toBe('pending')
  })

  it('ignores admission on an open issuance, as in Phase 1', () => {
    expect(holderRole(none, false)).toBe('investor')
    expect(holderRole(requested, false)).toBe('investor')
    expect(holderRole({ ...requested, locked: true }, false)).toBe('locked')
  })

  it('labels a pending account as an investor, as the handoff does', () => {
    expect(ROLE_LABEL.pending).toBe('Investor')
    expect(ROLE_WITH_ARTICLE.pending).toBe('an investor')
  })
})
