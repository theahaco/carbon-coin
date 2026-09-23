import { GhostsigError, ghostsigSign } from './ghostsig'
import { blobToUrlParam } from './blob'
import { absoluteUrlWithBase } from './paths'

export type CeremonyOutcome =
  | { status: 'submitted'; hash: string; address: string }
  | { status: 'handoff'; shareUrl: string; blob: string; quorumStatus: string; address: string }
  | { status: 'error'; message: string }

/**
 * Signs `payload` as `address` via GHOSTSIG and interprets the result: once
 * quorum is met GHOSTSIG submits itself (`submitted`); otherwise it hands
 * back a partially-signed blob for the next signer (`handoff`). This single
 * function backs both "Propose" (the first signature) and `/sign` (every
 * subsequent one) -- there's no other difference between them.
 *
 * `result.handOver`, when present, is a plain-English status message (e.g.
 * "1 of 2 by weight after this signature: hand the signed transaction to
 * the next signer") -- it is NOT the blob. The actual partially-signed
 * transaction to relay is always in `result.blob` (hex), regardless of
 * whether `handOver` is set.
 */
export async function signCeremonyPayload(payload: Record<string, unknown>, address: string): Promise<CeremonyOutcome> {
  try {
    const result = await ghostsigSign({ payload, address, submit: true })
    if (result.handOver) {
      const shareUrl = `${absoluteUrlWithBase('/sign')}?b=${blobToUrlParam(result.blob)}`
      return { status: 'handoff', shareUrl, blob: result.blob, quorumStatus: result.handOver, address: result.address }
    }
    return { status: 'submitted', hash: result.hash, address: result.address }
  } catch (err) {
    if (err instanceof GhostsigError) {
      return { status: 'error', message: err.message }
    }
    return { status: 'error', message: err instanceof Error ? err.message : String(err) }
  }
}
