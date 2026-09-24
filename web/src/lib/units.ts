/**
 * The scale of the Phase 1 issuance, which sets no AssetScale: the ledger
 * stores raw integers and the app has always shown 1 unit per 10^9 raw. A
 * deployment.json without `assetScale` is from that issuance, so this stays
 * the default.
 */
export const LEGACY_LEDGER_SCALE = 9

/** Largest AssetScale that can still show a whole unit (an MPT amount is at most 2^63 - 1, 19 digits). */
export const MAX_LEDGER_SCALE = 19

/** The largest raw MPT amount the ledger accepts (2^63 - 1). */
const MAX_RAW_AMOUNT = 2n ** 63n - 1n

/** Units always show, and are entered with, at most this many decimals. */
export const UNIT_DECIMALS = 3

const STEPS_PER_UNIT = 10n ** BigInt(UNIT_DECIMALS)

/**
 * Display convention: one displayed unit is 10^scale raw ledger units. With
 * an issuance's AssetScale that's the ledger's own convention, so the app,
 * the CLI and the explorer agree. `config.ts` sets it when deployment.json
 * loads, before any page formats an amount.
 */
let ledgerScale = LEGACY_LEDGER_SCALE

/** Sets the scale from deployment.json's `assetScale`; `undefined` keeps the legacy 10^9. */
export function setLedgerScale(assetScale: number | undefined): void {
  if (assetScale === undefined) {
    ledgerScale = LEGACY_LEDGER_SCALE
    return
  }
  if (!Number.isInteger(assetScale) || assetScale < 0 || assetScale > MAX_LEDGER_SCALE) {
    throw new Error(`deployment.json has an invalid assetScale (${String(assetScale)}): expected a whole number from 0 to ${MAX_LEDGER_SCALE}.`)
  }
  ledgerScale = assetScale
}

/** The current scale: raw ledger units per displayed unit is 10^this. */
export function getLedgerScale(): number {
  return ledgerScale
}

function toBigInt(raw: string | bigint): bigint {
  return typeof raw === 'bigint' ? raw : BigInt(raw)
}

/** Raw units per displayed thousandth. Only meaningful when the scale has at least 3 decimals. */
function rawPerThousandth(): bigint {
  return 10n ** BigInt(ledgerScale - UNIT_DECIMALS)
}

/** Floors a raw ledger amount to whole thousandths of a unit (as an integer count of thousandths). */
function flooredThousandths(raw: bigint): bigint {
  if (ledgerScale < UNIT_DECIMALS) return raw * 10n ** BigInt(UNIT_DECIMALS - ledgerScale)
  const step = rawPerThousandth()
  if (raw >= 0n) return raw / step
  return -((-raw + step - 1n) / step)
}

/**
 * Formats a raw ledger amount as units: always 3 decimals, floored (never
 * rounded up), with en-GB grouping, e.g. `235,187.958`.
 */
export function formatUnits(raw: string | bigint): string {
  const thousandths = flooredThousandths(toBigInt(raw))
  const negative = thousandths < 0n
  const abs = negative ? -thousandths : thousandths
  const whole = (abs / STEPS_PER_UNIT).toLocaleString('en-GB')
  const fraction = (abs % STEPS_PER_UNIT).toString().padStart(UNIT_DECIMALS, '0')
  return `${negative ? '−' : ''}${whole}.${fraction}`
}

/**
 * Whether a raw amount is a whole number of thousandths of a unit, so 3
 * decimals show it exactly. Always true at a scale of 3 or less.
 */
export function isWholeThousandths(raw: string | bigint): boolean {
  if (ledgerScale <= UNIT_DECIMALS) return true
  return toBigInt(raw) % rawPerThousandth() === 0n
}

/**
 * Formats one transaction's amount. Whole thousandths show as usual
 * (`25,000.000`); anything finer shows every digit down to the ledger scale
 * (`25,000.000999999`), so a co-signer or the public ledger never sees a
 * floored figure for a single payment. Balances and totals use `formatUnits`.
 */
export function formatAmountExact(raw: string | bigint): string {
  const value = toBigInt(raw)
  if (isWholeThousandths(value)) return formatUnits(value)
  const negative = value < 0n
  const abs = negative ? -value : value
  const scale = 10n ** BigInt(ledgerScale)
  const fraction = (abs % scale).toString().padStart(ledgerScale, '0').replace(/0+$/, '')
  return `${negative ? '−' : ''}${(abs / scale).toLocaleString('en-GB')}.${fraction}`
}

/**
 * Parses a units amount typed by a keyholder (grouping commas and spaces
 * allowed, at most 3 decimals, fewer if the ledger scale has fewer) into the
 * raw ledger integer string.
 */
export function parseUnits(input: string): string {
  const clean = input.trim().replace(/[,\s_]/g, '')
  const decimals = Math.min(UNIT_DECIMALS, ledgerScale)
  const pattern = decimals === 0 ? /^\d+$/ : new RegExp(`^\\d+(\\.\\d{1,${decimals}})?$`)
  if (!pattern.test(clean)) {
    throw new Error(
      decimals === 0
        ? 'Enter whole units, e.g. 25,000.'
        : `Enter units as a number with at most ${decimals} decimals, e.g. 25,000.${'0'.repeat(decimals)}.`,
    )
  }
  const [whole = '0', fraction = ''] = clean.split('.')
  const raw = BigInt(whole) * 10n ** BigInt(ledgerScale) + BigInt(fraction.padEnd(ledgerScale, '0') || '0')
  if (raw === 0n) throw new Error('Enter more than zero units.')
  if (raw > MAX_RAW_AMOUNT) throw new Error('That is more units than the ledger can hold.')
  return raw.toString()
}

/** Raw ledger amount for a whole number of thousandths of a unit, floored when the scale is coarser than thousandths. */
export function rawFromThousandths(thousandths: bigint): bigint {
  if (ledgerScale < UNIT_DECIMALS) return thousandths / 10n ** BigInt(UNIT_DECIMALS - ledgerScale)
  return thousandths * rawPerThousandth()
}
