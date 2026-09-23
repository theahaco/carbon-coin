import { mptToUnits, unitsToMpt } from 'xrpl'

// Display convention only: this token still uses raw units with no AssetScale.
const GTON_DISPLAY_SCALE = 9

export function toGton(raw: string | bigint): string {
  return unitsToMpt(String(raw), GTON_DISPLAY_SCALE)
}

export function fromGton(input: string): string {
  return mptToUnits(input.trim(), GTON_DISPLAY_SCALE)
}
