/**
 * Everything that names or dresses the demo lives here, so a variant is a
 * config swap (plus the colour tokens at the top of styles/global.css).
 *
 * The token's ticker and name are NOT here: they come from deployment.json
 * at runtime (see lib/config.ts), so the site always shows what the ledger
 * issuance actually says.
 *
 * Every figure below is fictional. Cash and NAV are illustrative only: they
 * never touch the ledger, which records units alone.
 */

export interface IllustrativeDealing {
  /** Cleared subscription cash for the dealing day, in euros. */
  cash: number
  /** NAV per unit struck for the dealing day, in euros (4 dp). */
  nav: number
}

export type KeySet = 'register' | 'desk'

export interface BrandConfig {
  /** Short name: wordmark, page titles. */
  name: string
  /** Wordmark sub-line. */
  subtitle: string
  /** Full product name, used as the overview H1. */
  fullName: string
  /** Share-class label, used on the About page. */
  classLabel: string
  /** Façade frieze text. */
  frieze: string
  /** First sentence of the overview lead. */
  lead: string
  /** The tagline, second half of the overview lead. */
  tagline: string
  /** The sticky band on every page. */
  band: string
  /** Footer line on every page. */
  footer: string
  /** One-sentence meta description. */
  description: string
  /** Names of the two multisig key sets. */
  keySets: Record<KeySet, { name: string; label: string; role: string }>
  /** Seat names by signer-list index. The published signer order decides who is which seat. */
  seats: Record<KeySet, string[]>
  /** Illustrative dealing figures per dealing day (YYYY-MM), with a fallback for any other day. */
  dealing: { fallback: IllustrativeDealing; days: Record<string, IllustrativeDealing> }
  /** Redemption terms on the About page. */
  redemptionTerms: Array<{ term: string; value: string }>
}

export const brand: BrandConfig = {
  name: 'Harrowquay',
  subtitle: 'Real Estate Fund · Class X (tokenised)',
  fullName: 'Harrowquay Real Estate Fund, Class X (tokenised)',
  classLabel: 'Class X',
  frieze: 'HARROWQUAY',
  lead: 'A tokenised share class on the XRP Ledger.',
  tagline: 'The register counts the units. The dealing desk names the holders.',
  band: 'FICTIONAL FUND · TESTNET DEMO · NOT AN OFFER',
  footer: 'Harrowquay is a fictional fund on the XRPL testnet. Nothing here is an offer.',
  description:
    'Harrowquay Real Estate Fund, Class X (tokenised): a fictional fund share class on the XRP Ledger testnet, showing two-stage dealing with two separate 2-of-3 key sets. Testnet demo, not an offer.',
  keySets: {
    register: { name: 'The Register', label: 'Register key', role: 'a Register key' },
    desk: { name: 'The Dealing Desk', label: 'Dealing Desk key', role: 'a Dealing Desk key' },
  },
  seats: {
    register: ['Depositary', 'Registrar', 'Administrator'],
    desk: ['Dealing', 'Operations', 'Compliance'],
  },
  dealing: {
    fallback: { cash: 2_450_000, nav: 10.4172 },
    days: {
      '2026-07': { cash: 1_800_000, nav: 10.215 },
      '2026-08': { cash: 2_100_000, nav: 10.3048 },
      '2026-09': { cash: 1_650_000, nav: 10.3611 },
      '2026-10': { cash: 2_450_000, nav: 10.4172 },
    },
  },
  redemptionTerms: [
    { term: 'Redemption dealing', value: 'Quarterly' },
    { term: 'Notice', value: '90 days' },
    { term: 'Gate', value: '5% of NAV per quarter' },
    { term: 'When gated', value: 'Filled pro rata' },
  ],
}

/** The seat name for signer-list index `index`, or a neutral fallback past the configured seats. */
export function seatName(keySet: KeySet, index: number): string {
  return brand.seats[keySet][index] ?? `Seat ${index + 1}`
}
