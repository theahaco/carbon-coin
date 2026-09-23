import { brand, seatName, type KeySet } from '../brand'
import type { PublicAccountConfig, PublicDeploymentConfig } from './config'

/**
 * Roles in the demo. Register and Dealing Desk come from the published
 * signer lists (the Register is the issuer account's list, the Dealing Desk
 * the governance account's). Everyone else connected is an investor, and
 * `locked` is an investor whose holding carries the MPToken lock flag.
 */
export type RoleKind = 'visitor' | 'investor' | 'locked' | 'register' | 'desk'

export const ROLE_LABEL: Record<RoleKind, string> = {
  visitor: 'Visitor',
  investor: 'Investor',
  locked: 'Investor',
  register: brand.keySets.register.label,
  desk: brand.keySets.desk.label,
}

export const ROLE_WITH_ARTICLE: Record<RoleKind, string> = {
  visitor: 'a visitor',
  investor: 'an investor',
  locked: 'an investor',
  register: brand.keySets.register.role,
  desk: brand.keySets.desk.role,
}

export interface Seat {
  keySet: KeySet
  /** Index in the published signer list. */
  index: number
  name: string
  address: string
}

export function keySetAccount(config: PublicDeploymentConfig, keySet: KeySet): PublicAccountConfig | undefined {
  return keySet === 'register' ? config.issuer : config.governance
}

/** Every seat of a key set, in signer-list order. */
export function seatsOf(config: PublicDeploymentConfig, keySet: KeySet): Seat[] {
  return (keySetAccount(config, keySet)?.signers ?? []).map((signer, index) => ({
    keySet,
    index,
    name: seatName(keySet, index),
    address: signer.address,
  }))
}

/** The seat `address` holds on `keySet`, if any. */
export function seatOn(config: PublicDeploymentConfig, keySet: KeySet, address: string): Seat | undefined {
  return seatsOf(config, keySet).find((seat) => seat.address === address)
}

/** The first seat `address` holds, Register before Dealing Desk. */
export function seatFor(config: PublicDeploymentConfig, address: string): Seat | undefined {
  return seatOn(config, 'register', address) ?? seatOn(config, 'desk', address)
}

/** The key set that controls `account` (the issuer is the Register, governance the Dealing Desk). */
export function keySetOf(config: PublicDeploymentConfig, account: string): KeySet | undefined {
  if (config.issuer?.address === account) return 'register'
  if (config.governance?.address === account) return 'desk'
  return undefined
}

/** The role for the header pill, from the signer lists alone (no ledger read). */
export function signerRole(config: PublicDeploymentConfig, address: string | null): RoleKind {
  if (!address) return 'visitor'
  const seat = seatFor(config, address)
  return seat ? seat.keySet : 'investor'
}

const NUMBER_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten']

/** `two`, `three`, ... for small counts; digits otherwise. */
export function numberWord(n: number): string {
  return NUMBER_WORDS[n] ?? String(n)
}

/** "the Depositary or the Administrator", "Operations or Compliance" style lists of the seats still to sign. */
export function waitingFor(seats: Seat[]): string {
  const names = seats.map((seat) => (seat.keySet === 'register' ? `the ${seat.name}` : seat.name))
  if (names.length <= 1) return names[0] ?? 'the next keyholder'
  return `${names.slice(0, -1).join(', ')} or ${names[names.length - 1]}`
}
