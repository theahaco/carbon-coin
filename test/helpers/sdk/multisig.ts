import { Wallet } from 'xrpl'
import type { SignerWallet } from './config.js'

/** Equal-weight signer entries for this demo's N-of-M policy. */
export function signerListFields(signers: SignerWallet[], quorum: number) {
  if (!Number.isInteger(quorum) || quorum < 1 || quorum > signers.length) {
    throw new Error(`Invalid quorum ${quorum} for ${signers.length} signer(s).`)
  }
  if (new Set(signers.map(({ address }) => address)).size !== signers.length) {
    throw new Error('Signer addresses must be unique.')
  }
  return {
    SignerQuorum: quorum,
    SignerEntries: signers.map(({ address }) => ({
      SignerEntry: { Account: address, SignerWeight: 1 },
    })),
  }
}

/** Select locally available signers; external signers must use the browser ceremony. */
export function localSigners(signers: SignerWallet[], quorum: number): Wallet[] {
  signerListFields(signers, quorum)
  const available = signers.filter(({ seed }) => seed.length > 0).slice(0, quorum)
  if (available.length < quorum) {
    throw new Error(
      `This account needs ${quorum} signatures but only ${available.length} local signer(s) are available. Use the GhostSig browser ceremony.`,
    )
  }
  return available.map(({ seed }) => Wallet.fromSeed(seed))
}
