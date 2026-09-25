// Types for independent SDK ledger fixtures; production keys belong to the Rust CLI.
export interface SignerWallet {
  address: string
  seed: string
}

export interface AccountState {
  address: string
  /** Master seed. Kept for local reference only; the master key is disabled
   * immediately after the SignerList is configured, so this seed cannot sign
   * anything for the account going forward (mint/lock/clawback/etc. all
   * require the signer quorum below). */
  seed: string
  signers: SignerWallet[]
  quorum: number
}
