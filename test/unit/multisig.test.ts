import { describe, expect, it } from 'vitest'
import { Client, Wallet } from 'xrpl'
import { localSigners, signerListFields } from '../../src/lib/multisig.js'

const external = { address: 'rExternal', seed: '' }
const firstWallet = Wallet.generate()
const secondWallet = Wallet.generate()
const first = { address: firstWallet.address, seed: firstWallet.seed! }
const second = { address: secondWallet.address, seed: secondWallet.seed! }

describe('local signer selection', () => {
  it('selects available keys without depending on storage order', () => {
    expect(localSigners([external, first, second], 2).map(({ address }) => address)).toEqual([
      first.address,
      second.address,
    ])
  })
  it('directs an external quorum to the signing ceremony before preparing a transaction', () => {
    expect(() => localSigners([external, first], 2)).toThrow(/GhostSig browser ceremony/)
  })
  it('returns signing errors through the explicit outcome too', async () => {
    const client = new Client('ws://localhost:6006')
    const outcome = await client
      .forAccount(first.address)
      .tx.mpTokenAuthorize({ MPTokenIssuanceID: '0'.repeat(48) })
      .tryMultisignAndSubmit([])
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.error.message).toMatch(/signersCount/)
  })
  it('rejects duplicate signers and fractional quorum before disabling a master key', () => {
    expect(() => signerListFields([first, first], 2)).toThrow(/unique/)
    expect(() => signerListFields([first, second], 1.5)).toThrow(/Invalid quorum/)
  })
})
