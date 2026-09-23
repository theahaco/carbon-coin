import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearStoredAddress, getStoredAddress, setStoredAddress } from '../../src/lib/session'

/** A plain in-memory Storage: newer Node versions ship their own global localStorage that shadows jsdom's. */
function memoryStorage(): Storage {
  const items = new Map<string, string>()
  return {
    get length() {
      return items.size
    },
    clear: () => items.clear(),
    getItem: (key) => items.get(key) ?? null,
    key: (index) => [...items.keys()][index] ?? null,
    removeItem: (key) => void items.delete(key),
    setItem: (key, value) => void items.set(key, String(value)),
  }
}

describe('stored GhostSig address', () => {
  beforeEach(() => vi.stubGlobal('localStorage', memoryStorage()))
  afterEach(() => vi.unstubAllGlobals())

  it('reads the old key once and migrates it to the neutral one', () => {
    localStorage.setItem('carbonCoin:ghostsigAddress', 'rOld')
    expect(getStoredAddress()).toBe('rOld')
    expect(localStorage.getItem('mptDemo:ghostsigAddress')).toBe('rOld')
    expect(localStorage.getItem('carbonCoin:ghostsigAddress')).toBeNull()
  })

  it('prefers the neutral key and clears both', () => {
    setStoredAddress('rNew')
    localStorage.setItem('carbonCoin:ghostsigAddress', 'rOld')
    expect(getStoredAddress()).toBe('rNew')
    clearStoredAddress()
    expect(getStoredAddress()).toBeNull()
  })
})
