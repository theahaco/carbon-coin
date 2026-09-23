import { mptToUnits } from 'xrpl'

/**
 * Display convention only. The issuance sets no AssetScale, so the ledger
 * stores raw integers; the app has always shown 1 unit per 10^9 raw. That
 * scale is unchanged here (changing it needs a re-issue).
 */
export const LEDGER_DISPLAY_SCALE = 9

/** Units always show, and are entered with, at most this many decimals. */
export const UNIT_DECIMALS = 3

const RAW_PER_DISPLAYED_STEP = 10n ** BigInt(LEDGER_DISPLAY_SCALE - UNIT_DECIMALS)
const STEPS_PER_UNIT = 10n ** BigInt(UNIT_DECIMALS)

/** Floors a raw ledger amount to whole thousandths of a unit (as an integer count of thousandths). */
function flooredThousandths(raw: bigint): bigint {
  if (raw >= 0n) return raw / RAW_PER_DISPLAYED_STEP
  return -((-raw + RAW_PER_DISPLAYED_STEP - 1n) / RAW_PER_DISPLAYED_STEP)
}

/**
 * Formats a raw ledger amount as units: always 3 decimals, floored (never
 * rounded up), with en-GB grouping, e.g. `235,187.958`.
 */
export function formatUnits(raw: string | bigint): string {
  const thousandths = flooredThousandths(typeof raw === 'bigint' ? raw : BigInt(raw))
  const negative = thousandths < 0n
  const abs = negative ? -thousandths : thousandths
  const whole = (abs / STEPS_PER_UNIT).toLocaleString('en-GB')
  const fraction = (abs % STEPS_PER_UNIT).toString().padStart(UNIT_DECIMALS, '0')
  return `${negative ? '−' : ''}${whole}.${fraction}`
}

/** Whether a raw amount is a whole number of thousandths of a unit, so 3 decimals show it exactly. */
export function isWholeThousandths(raw: string | bigint): boolean {
  return (typeof raw === 'bigint' ? raw : BigInt(raw)) % RAW_PER_DISPLAYED_STEP === 0n
}

/**
 * Formats one transaction's amount. Whole thousandths show as usual
 * (`25,000.000`); anything finer shows every digit down to the ledger scale
 * (`25,000.000999999`), so a co-signer or the public ledger never sees a
 * floored figure for a single payment. Balances and totals use `formatUnits`.
 */
export function formatAmountExact(raw: string | bigint): string {
  const value = typeof raw === 'bigint' ? raw : BigInt(raw)
  if (isWholeThousandths(value)) return formatUnits(value)
  const negative = value < 0n
  const abs = negative ? -value : value
  const scale = 10n ** BigInt(LEDGER_DISPLAY_SCALE)
  const fraction = (abs % scale).toString().padStart(LEDGER_DISPLAY_SCALE, '0').replace(/0+$/, '')
  return `${negative ? '−' : ''}${(abs / scale).toLocaleString('en-GB')}.${fraction}`
}

/**
 * Parses a units amount typed by a keyholder (grouping commas and spaces
 * allowed, at most 3 decimals) into the raw ledger integer string.
 */
export function parseUnits(input: string): string {
  const clean = input.trim().replace(/[,\s_]/g, '')
  if (!/^\d+(\.\d{1,3})?$/.test(clean)) {
    throw new Error(`Enter units as a number with at most ${UNIT_DECIMALS} decimals, e.g. 25,000.000.`)
  }
  const raw = mptToUnits(clean, LEDGER_DISPLAY_SCALE)
  if (BigInt(raw) === 0n) throw new Error('Enter more than zero units.')
  return raw
}

/** Raw ledger amount for a whole number of thousandths of a unit. */
export function rawFromThousandths(thousandths: bigint): bigint {
  return thousandths * RAW_PER_DISPLAYED_STEP
}
