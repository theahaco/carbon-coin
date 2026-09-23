/**
 * Small HTML builders shared by the page scripts. Every interpolated value
 * goes through `esc`; addresses and amounts come from the ledger or config.
 */
import QRCode from 'qrcode'
import { brand, type KeySet } from '../brand'
import { formatEuro, type ContractNote } from './dealing'
import { esc } from './format'
import { problemCopy, type ProblemStatus } from './outcome'
import type { ReadinessNotice } from './readiness'
import { ROLE_WITH_ARTICLE, waitingFor, type RoleKind, type Seat } from './role'
import { formatUnits } from './units'
import { withBase } from './paths'
import { TESTNET_EXPLORER_BASE } from './xrplClient'

/**
 * Escapes a plain-language sentence and keeps its references on one line:
 * dealing days (`2026-10`), order refs (`ORD-2026-10-014`) and short
 * addresses (`rAb7Tq…Q7Kx`) never break at a hyphen.
 */
export function sentenceHtml(text: string): string {
  return esc(text).replace(/\b(?:[A-Z]{2,}-[\w-]+|\d{4}-\d{2}|r\w{5}…\w{4})/g, (token) => `<span class="nowrap">${token}</span>`)
}

export function statusHtml(kind: 'error' | 'success' | 'info', text: string): string {
  return `<div class="status ${kind === 'info' ? '' : kind}" role="${kind === 'error' ? 'alert' : 'status'}">${esc(text)}</div>`
}

/**
 * Seat chips for a key set. `signed` seats are solid with a check; `you` is
 * suffixed " · you", and bold unless `emphasiseYou` is false (the co-sign
 * strip keeps it a plain outlined chip; the proposer's own chip is bold).
 */
export function chipsHtml(seats: Seat[], opts: { signed?: ReadonlySet<string>; you?: string; emphasiseYou?: boolean } = {}): string {
  const emphasise = opts.emphasiseYou ?? true
  return `<div class="row-wrap" style="gap:6px">${seats
    .map((seat) => {
      const signed = opts.signed?.has(seat.address) ?? false
      const you = seat.address === opts.you
      const classes = ['chip', seat.keySet === 'desk' ? 'desk' : '', signed ? 'signed' : '', you && !signed && emphasise ? 'you' : '']
        .filter(Boolean)
        .join(' ')
      const label = `${seat.name}${you ? ' · you' : ''}${signed ? ' ✓' : ''}`
      return `<span class="${classes}">${esc(label)}</span>`
    })
    .join('')}</div>`
}

/** "1 of 2 keys", with one segment per required signature. */
export function keyMeterHtml(keySet: KeySet, signedCount: number, quorum: number): string {
  const segments = Array.from({ length: Math.max(quorum, 1) }, (_, i) => `<span class="segment${i < signedCount ? ' on' : ''}"></span>`)
  return `<span class="key-meter${keySet === 'desk' ? ' desk' : ''}"><span class="segments" aria-hidden="true">${segments.join('')}</span>${esc(`${Math.min(signedCount, quorum)} of ${quorum} keys`)}</span>`
}

/** The contract note card: cleared cash ÷ NAV = units, illustrative. */
export function contractNoteHtml(note: ContractNote, ticker: string, opts: { compact?: boolean } = {}): string {
  if (opts.compact) {
    return `<div class="note compact">
      <div class="note-head"><span class="note-title">Contract note</span><span class="note-tag">${esc(note.day)} · Illustrative</span></div>
      <div class="note-body">
        <div class="note-row"><span class="note-key">Cleared cash</span><span>${esc(formatEuro(note.cash, 2))}</span></div>
        <div class="note-row"><span class="note-key">÷ NAV per unit</span><span>${esc(formatEuro(note.nav, 4))}</span></div>
        <div class="note-row"><span class="note-key">= Units</span><span style="font-weight:600">${esc(formatUnits(note.unitsRaw))} ${esc(ticker)}</span></div>
      </div>
    </div>`
  }
  return `<div class="note">
    <div class="note-head"><span class="note-title">Contract note</span><span class="note-tag">Dealing day ${esc(note.day)} · Illustrative</span></div>
    <div class="note-body">
      <div class="note-row"><span class="note-key">Cleared cash <small>(illustrative)</small></span><span class="note-value">${esc(formatEuro(note.cash, 2))}</span></div>
      <div class="note-row"><span class="note-key">÷ NAV per unit <small>(illustrative)</small></span><span class="note-value">${esc(formatEuro(note.nav, 4))}</span></div>
      <div class="note-row"><span class="note-key">= Units to issue</span><span class="note-units">${esc(formatUnits(note.unitsRaw))} <small>${esc(ticker)}</small></span></div>
    </div>
    <div class="note-foot">Issued to the Dealing Desk. Pre-filled from fund config.</div>
  </div>`
}

const NON_SIGNER_BODY: Record<KeySet, string> = {
  register: `Dealing day is run by Register keyholders: the ${brand.seats.register.slice(0, -1).join(', the ')} and the ${brand.seats.register.at(-1)}. Two of the three sign to issue units to the Dealing Desk against cleared cash, at that day's NAV.`,
  desk: `Deliveries are made by Dealing Desk keyholders: ${brand.seats.desk.slice(0, -1).join(', ')} and ${brand.seats.desk.at(-1)}. Two of the three sign to sell issued units to each investor who ordered them.`,
}

/** The card shown when a page needs a key the viewer doesn't hold: explains the role, no error. */
export function nonSignerHtml(needs: KeySet, role: RoleKind): string {
  const visitor = role === 'visitor'
  const pill = visitor ? "You're viewing as a visitor" : `You're connected as ${ROLE_WITH_ARTICLE[role]}`
  return `<span class="role-pill" style="align-self:flex-start"><span class="role-dot" data-role="${esc(role)}"></span>${esc(pill)}</span>
    <p>${esc(NON_SIGNER_BODY[needs])}</p>
    <p class="meta">${visitor ? 'Keyholders connect a passkey to sign. ' : ''}Nothing to sign here. The result appears on the fund overview and in the register ledger.</p>
    <div class="row-wrap">
      ${visitor ? '<button type="button" class="btn btn-primary" data-connect>Connect passkey</button>' : ''}
      <a class="btn btn-secondary" href="${esc(withBase('/'))}">Fund overview</a>
    </div>`
}

export interface HandoffOptions {
  keySet: KeySet
  seats: Seat[]
  /** Addresses whose signatures are already on the blob. */
  signed: ReadonlySet<string>
  quorum: number
  /** The plain-language line, decoded from the transaction. */
  relay: string
  shareUrl: string
}

/** Renders the shared "Pass to the next keyholder" card into `container`. */
export async function renderHandoff(container: HTMLElement, opts: HandoffOptions): Promise<void> {
  const waiting = opts.seats.filter((seat) => !opts.signed.has(seat.address))
  container.className = 'card'
  container.style.gap = '16px'
  container.innerHTML = `
    <div class="split" style="align-items:center">
      <span class="card-title">Pass to the next keyholder</span>
      ${keyMeterHtml(opts.keySet, opts.signed.size, opts.quorum)}
    </div>
    ${chipsHtml(opts.seats, { signed: opts.signed })}
    <div class="stack-tight">
      <span class="label">Relay message</span>
      <div class="relay">${sentenceHtml(opts.relay)}</div>
    </div>
    <div class="handoff-grid">
      <div class="stack-tight" style="gap:8px">
        <span class="label">Signing link</span>
        <span class="link-box" data-link></span>
        <button type="button" class="btn btn-ink" data-copy>Copy link</button>
      </div>
      <div class="stack-tight" style="gap:8px;align-items:flex-start">
        <span class="label">Or scan</span>
        <img class="qr" data-qr alt="QR code of the signing link" width="160" height="160" />
      </div>
    </div>
    <div class="handoff-foot">
      <span class="meta" data-waiting>Waiting for ${esc(waitingFor(waiting))}</span>
    </div>`
  const link = container.querySelector<HTMLElement>('[data-link]')!
  link.textContent = opts.shareUrl
  const copy = container.querySelector<HTMLButtonElement>('[data-copy]')!
  copy.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(opts.shareUrl)
      copy.textContent = 'Link copied ✓'
      copy.className = 'btn btn-copied'
    } catch {
      copy.textContent = 'Copy failed: select the link'
    }
  })
  const qr = container.querySelector<HTMLImageElement>('[data-qr]')!
  qr.src = await QRCode.toDataURL(opts.shareUrl, { margin: 1, width: 320, color: { dark: '#1F2A33', light: '#FBFAF7' } })
}

/**
 * The inside of the `panel panel-alert` shown when a proposal settles
 * without going through. It never shows the past-tense result line, because
 * nothing happened; `proposal` is the present-tense sentence, for reference.
 */
export function problemPanelHtml(status: ProblemStatus, proposal: string, actionsHtml: string): string {
  const copy = problemCopy(status)
  const hash = status.status === 'unknown' ? undefined : status.hash
  const explorer = hash
    ? `<a class="btn btn-secondary" href="${esc(`${TESTNET_EXPLORER_BASE}/transactions/${hash}`)}" target="_blank" rel="noopener noreferrer">View on testnet explorer ↗</a>`
    : ''
  return `
    <span class="panel-label">${esc(copy.label)}</span>
    <p class="result-sentence">${esc(copy.headline)}</p>
    <p class="body-2">${esc(copy.detail)}</p>
    <p class="small-muted">The proposal was: ${sentenceHtml(proposal)}</p>
    <div class="row-wrap">${actionsHtml}${explorer}</div>`
}

/** The transfer-readiness notice as an alert panel. `extraHtml` goes at the end (e.g. a "Check again" button). */
export function readinessHtml(notice: ReadinessNotice, extraHtml = ''): string {
  return `<div class="panel panel-alert" role="status">
    <span class="panel-label">${esc(notice.label)}</span>
    ${notice.lines.map((line) => `<span>${sentenceHtml(line)}</span>`).join('')}
    ${extraHtml}
  </div>`
}
