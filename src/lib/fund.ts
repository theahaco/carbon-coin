import { Client, Wallet, xrpToDrops, ECDSA } from 'xrpl'
import { STANDALONE_GENESIS_ACCOUNT, type NetworkConfig } from './network.js'
import { withWalletClient } from './client.js'
import type { SignerWallet } from './config.js'

/**
 * XRP (not drops) sent to each freshly generated wallet on the local
 * stand-alone network. Generous relative to real reserve requirements
 * (currently ~1 XRP base + ~0.2 XRP per owned object) since XRP is free
 * there; this just avoids ever having to think about reserves locally.
 */
const LOCAL_FUNDING_AMOUNT_XRP = '1000'

/**
 * Creates and funds a new wallet. On the local stand-alone network this pays
 * from the well-known genesis account; on Testnet it uses the public faucet.
 * Both paths return a ready-to-use Wallet with a comparable XRP balance, so
 * calling code doesn't need to branch on network.
 */
export async function fundNewWallet(client: Client, network: NetworkConfig): Promise<Wallet> {
  if (network.name === 'local') {
    const wallet = Wallet.generate()
    // The genesis account's published address was derived with secp256k1;
    // xrpl.js defaults Wallet.fromSeed to ed25519, which yields a different
    // (wrong) address for this seed, so the algorithm must be explicit.
    const genesis = Wallet.fromSeed(STANDALONE_GENESIS_ACCOUNT.secret, { algorithm: ECDSA.secp256k1 })
    await withWalletClient(client, genesis, async (signing) => {
      await signing.tx.payment({
        Destination: wallet.address,
        Amount: xrpToDrops(LOCAL_FUNDING_AMOUNT_XRP),
      }).signAndSubmit()
    })
    return wallet
  }

  const { wallet } = await client.fundWallet(undefined, { amount: LOCAL_FUNDING_AMOUNT_XRP })
  return wallet
}

/** Funds `count` new placeholder signer wallets, in the shape persisted to .deployment.json. */
export async function fundSignerWallets(client: Client, network: NetworkConfig, count: number): Promise<SignerWallet[]> {
  const signers: SignerWallet[] = []
  for (let i = 0; i < count; i++) {
    const wallet = await fundNewWallet(client, network)
    signers.push({ address: wallet.address, seed: wallet.seed! })
  }
  return signers
}

/** Parses a comma-separated list of r-addresses from an env var, e.g. `ISSUER_SIGNER_ADDRESSES`. */
export function parseSignerAddressesEnv(value: string | undefined): string[] {
  if (!value) return []
  return value
    .split(',')
    .map((address) => address.trim())
    .filter((address) => address.length > 0)
}

/**
 * Resolves the signer set for a multisig account. Any addresses in
 * `presetAddresses` (e.g. real, externally-controlled addresses such as a
 * GhostSig passkey wallet) are used as-is -- their seeds are never known to
 * this repo, so they're recorded with `seed: ''` as a sentinel meaning "this
 * signer must sign for itself; no local seed exists for it". Any remaining
 * slots up to `count` are filled with freshly funded, fully-automatic
 * placeholder wallets exactly as before. Passing no `presetAddresses`
 * reproduces today's fully-automatic behavior unchanged.
 *
 * Generated (seed-holding) wallets are listed *before* preset ones: the CLI
 * scripts select locally available seeds and explain when a browser
 * ceremony is needed to meet quorum. Ceremonies involving those
 * real signers instead happen through the browser (see `web/`), which
 * checks signer list membership directly rather than slicing by position.
 */
export async function resolveSignerWallets(
  client: Client,
  network: NetworkConfig,
  count: number,
  presetAddresses: string[] = [],
): Promise<SignerWallet[]> {
  const preset: SignerWallet[] = presetAddresses.map((address) => ({ address, seed: '' }))
  const remaining = Math.max(0, count - preset.length)
  const generated = await fundSignerWallets(client, network, remaining)
  return [...generated, ...preset]
}
