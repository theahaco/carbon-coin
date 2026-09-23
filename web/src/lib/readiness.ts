import type { MptTransferReadiness } from 'xrpl'
import { shortAddress } from './format'

/**
 * The SDK's advisory transfer checks, in the app's plain en-GB copy. The
 * SDK reports each check as an English sentence (no code), so this matches
 * the sentences of the pinned SDK and falls back to the SDK's own words for
 * anything it doesn't recognise.
 */
export interface ReadinessContext {
  destination: string
  /** How to name the sending account in a sentence: "The Dealing Desk", "Your account". */
  source: string
}

export interface ReadinessNotice {
  /** A blocked check means the ledger would reject the transfer as things stand. */
  blocked: boolean
  label: string
  lines: string[]
}

interface Mapped {
  label: string
  text: string
}

function mapCheck(message: string, ctx: ReadinessContext): Mapped {
  const destination = shortAddress(ctx.destination)
  switch (message) {
    case 'Destination has not authorized a holding for this MPT.':
      return {
        label: "Can't hold units yet",
        text: `${destination} hasn't set up a holding yet, so it can't receive units. It needs to connect and self-authorise on the fund overview first.`,
      }
    case 'Destination has not been authorized by the issuer.':
      return { label: "Can't hold units yet", text: `${destination} hasn't been authorised by the Register yet, so it can't receive units.` }
    case 'Source has not authorized a holding for this MPT.':
      return { label: 'No holding to send from', text: `${ctx.source} has no holding of these units.` }
    case 'Source has not been authorized by the issuer.':
      return { label: 'No holding to send from', text: `${ctx.source} hasn't been authorised by the Register.` }
    case 'The issuance or a holder is locked for this transfer.':
      return { label: 'Units are locked', text: "Units can't move right now: dealing is suspended, or a stop-transfer is in place on one of the holdings." }
    case 'This issuance does not permit transfers between holders.':
      return { label: 'Transfers not allowed', text: "This issuance doesn't allow transfers between holders." }
    case 'The source has insufficient MPT balance.':
      return { label: 'Not enough units', text: `${ctx.source} holds fewer units than this.` }
    case 'Source and destination must differ.':
      return { label: 'Check the destination', text: 'The destination is the sending account.' }
    case 'MPT issuance does not exist.':
      return { label: 'Issuance not found', text: "The issuance isn't on the ledger." }
    case 'Minting this amount would exceed the maximum supply.':
      return { label: 'Over the maximum', text: 'Issuing this many units would pass the maximum the issuance allows.' }
    case 'A transfer fee applies; the final debit requires an additional check.':
      return { label: 'Check the destination', text: 'A transfer fee applies, so the amount taken from the sender may be higher.' }
    default:
      if (/permissioned-domain credentials/.test(message)) {
        return { label: 'Check the destination', text: `${message.startsWith('Source') ? ctx.source : destination} needs a credentials check this page can't do.` }
      }
      return { label: 'Check the destination', text: message }
  }
}

/** Null when every check passed; otherwise the label of the first failing check and one line per failing check. */
export function describeReadiness(readiness: Pick<MptTransferReadiness, 'status' | 'checks'>, ctx: ReadinessContext): ReadinessNotice | null {
  if (readiness.status === 'eligible') return null
  const failing = readiness.checks.filter((check) => check.status !== 'pass')
  const blocked = failing.filter((check) => check.status === 'blocked')
  const lead = blocked[0] ?? failing[0]
  const mapped = failing.map((check) => mapCheck(check.message, ctx))
  return {
    blocked: readiness.status === 'blocked',
    label: lead ? mapCheck(lead.message, ctx).label : 'Check the destination',
    lines: mapped.map((m) => m.text),
  }
}
