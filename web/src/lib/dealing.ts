import { brand, type IllustrativeDealing } from '../brand'
import { rawFromThousandths } from './units'

/**
 * Dealing days are labelled `YYYY-MM` and ride on the issue's memo (memo
 * type `mint-period`, data `YYYY-MM`). Older issues may carry a numeric label
 * instead (`2026`, or `202610`); those still parse where they name a month
 * and are otherwise kept as plain labels.
 */
const DAY_PATTERN = /^(\d{4})-(0[1-9]|1[0-2])$/
const COMPACT_DAY_PATTERN = /^(\d{4})(0[1-9]|1[0-2])$/

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']

export interface DealingMonth {
  year: number
  /** 1-12 */
  month: number
}

export function isDealingDay(label: string): boolean {
  return DAY_PATTERN.test(label.trim())
}

/** The month a period label names: `YYYY-MM`, or a legacy numeric `YYYYMM`. Anything else (e.g. a bare year) names none. */
export function parseDealingMonth(label: string): DealingMonth | undefined {
  const trimmed = label.trim()
  const match = DAY_PATTERN.exec(trimmed) ?? COMPACT_DAY_PATTERN.exec(trimmed)
  if (!match) return undefined
  return { year: Number(match[1]), month: Number(match[2]) }
}

export function formatDealingDay({ year, month }: DealingMonth): string {
  return `${year}-${String(month).padStart(2, '0')}`
}

/** Whether two dealing-day labels name the same day (`2026-10` and a legacy `202610` do). */
export function sameDealingDay(a: string, b: string): boolean {
  const x = parseDealingMonth(a)
  const y = parseDealingMonth(b)
  return x && y ? x.year === y.year && x.month === y.month : a.trim() === b.trim()
}

export function nextMonth({ year, month }: DealingMonth): DealingMonth {
  return month === 12 ? { year: year + 1, month: 1 } : { year, month: month + 1 }
}

export function currentDealingDay(now: Date = new Date()): string {
  return formatDealingDay({ year: now.getFullYear(), month: now.getMonth() + 1 })
}

function monthIndex({ year, month }: DealingMonth): number {
  return year * 12 + month
}

/**
 * The dealing day to propose next: the month after the latest dealing day on
 * record, but never earlier than the current month (dealing days run on
 * their real dates, never backdated). The current month when none is on
 * record. Labels that name no month (a bare year from before dealing days)
 * don't count.
 */
export function suggestNextDealingDay(periods: string[], now: Date = new Date()): string {
  const current: DealingMonth = { year: now.getFullYear(), month: now.getMonth() + 1 }
  const months = periods.map(parseDealingMonth).filter((m): m is DealingMonth => m !== undefined)
  if (months.length === 0) return formatDealingDay(current)
  const latest = months.reduce((a, b) => (monthIndex(b) > monthIndex(a) ? b : a))
  const after = nextMonth(latest)
  return formatDealingDay(monthIndex(after) >= monthIndex(current) ? after : current)
}

/** "October", for a `YYYY-MM` day. */
export function monthName(day: string): string {
  const parsed = parseDealingMonth(day)
  return parsed ? (MONTHS[parsed.month - 1] ?? day) : day
}

export function monthShortName(month: number): string {
  return (MONTHS[month - 1] ?? '').slice(0, 3)
}

/** The illustrative cash and NAV for a dealing day, from brand config. */
export function illustrativeDealing(day: string): IllustrativeDealing {
  const key = parseDealingMonth(day)
  return (key && brand.dealing.days[formatDealingDay(key)]) || brand.dealing.fallback
}

/**
 * Units that `cash` buys at `nav`, floored to 3 decimals, as a raw ledger
 * amount. Integer arithmetic throughout (cash in cents, NAV in 1/10,000),
 * so there's no floating-point rounding at the boundary.
 */
export function unitsForCash(cash: number, nav: number): bigint {
  const cents = BigInt(Math.round(cash * 100))
  const navTenThousandths = BigInt(Math.round(nav * 10_000))
  if (cents < 0n || navTenThousandths <= 0n) throw new Error('Cash must be non-negative and NAV positive.')
  // thousandths = floor(cash * 1000 / nav) = floor((cents / 100) * 1000 / (navT / 10000))
  const thousandths = (cents * 100_000n) / navTenThousandths
  return rawFromThousandths(thousandths)
}

export interface ContractNote {
  day: string
  cash: number
  nav: number
  /** Units to issue, raw ledger amount. */
  unitsRaw: bigint
}

/** The dealing day's contract note: cleared cash ÷ NAV = units. Illustrative figures from brand config. */
export function contractNote(day: string): ContractNote {
  const { cash, nav } = illustrativeDealing(day)
  return { day, cash, nav, unitsRaw: unitsForCash(cash, nav) }
}

/** `€2,450,000.00` / `€10.4172`. € only ever appears on NAV and contract-note lines labelled illustrative. */
export function formatEuro(amount: number, decimals: number): string {
  return `€${amount.toLocaleString('en-GB', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}`
}

/** The contract note's short form, as used in the relay message and the co-sign sentence: `€2,450,000 ÷ NAV €10.4172`. */
export function noteShortForm(note: Pick<ContractNote, 'cash' | 'nav'>): string {
  return `${formatEuro(note.cash, 0)} ÷ NAV ${formatEuro(note.nav, 4)}`
}
