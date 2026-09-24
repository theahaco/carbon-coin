import { Client, Wallet, xrpToDrops, ECDSA } from 'xrpl'
import { STANDALONE_GENESIS_ACCOUNT, type NetworkConfig } from './network.js'
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
    const signing = client.withWallet(genesis)
    await signing.tx
      .payment({
        Destination: wallet.address,
        Amount: xrpToDrops(LOCAL_FUNDING_AMOUNT_XRP),
      })
      .signAndSubmit()
    return wallet
  }

  const { wallet } = await client.fundWallet(undefined, { amount: LOCAL_FUNDING_AMOUNT_XRP })
  return wallet
}

/** Funds `count` new placeholder signer wallets, in the shape persisted to .deployment.json. */
export async function fundSignerWallets(
  client: Client,
  network: NetworkConfig,
  count: number,
): Promise<SignerWallet[]> {
  const signers: SignerWallet[] = []
  for (let i = 0; i < count; i++) {
    const wallet = await fundNewWallet(client, network)
    signers.push({ address: wallet.address, seed: wallet.seed! })
  }
  return signers
}
