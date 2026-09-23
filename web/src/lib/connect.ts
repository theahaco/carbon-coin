/**
 * Shared "Connect passkey" control. `initConnectHeader()` is called once,
 * from Layout.astro, and owns the actual popup call, storage, and the
 * header's button / role pill. Any element with a `data-connect` attribute,
 * anywhere on the page (including ones a page script renders later),
 * starts the same connect flow. Pages that need to react to the connected
 * address subscribe via `onConnectionChange` instead.
 *
 * This works across Layout's `<script>` and a page's own `<script>` with no
 * DOM events: Astro/Vite treats both as importing the same ESM module
 * within one page load, so the `listeners` set below is a true singleton
 * for the lifetime of that page -- it only resets on a real navigation,
 * same as everything else in a per-page script.
 */
import { ghostsigConnect, GhostsigError } from './ghostsig'
import { getStoredAddress, setStoredAddress, clearStoredAddress } from './session'
import { loadPublicConfig } from './config'
import { ROLE_LABEL, signerRole, type RoleKind } from './role'

export type ConnectionListener = (address: string | null) => void

const listeners = new Set<ConnectionListener>()

function notify(address: string | null): void {
  for (const listener of listeners) listener(address)
}

/** Invokes `listener` immediately with the current address (or `null`), then again on every connect/disconnect. */
export function onConnectionChange(listener: ConnectionListener): void {
  listeners.add(listener)
  listener(getStoredAddress())
}

function errorText(err: unknown): string {
  return err instanceof GhostsigError ? err.message : err instanceof Error ? err.message : String(err)
}

/**
 * Opens the GhostSig popup and connects. Must run synchronously inside a
 * click (the popup has to open within the user gesture).
 */
function connectFromClick(trigger: HTMLButtonElement | null): void {
  const errorEl = document.getElementById('connect-error')
  if (trigger) trigger.disabled = true
  if (errorEl) errorEl.hidden = true
  ghostsigConnect()
    .then(({ address }) => {
      setStoredAddress(address)
      notify(address)
    })
    .catch((err: unknown) => {
      if (errorEl) {
        errorEl.textContent = errorText(err)
        errorEl.hidden = false
      }
    })
    .finally(() => {
      if (trigger) trigger.disabled = false
    })
}

/**
 * Refines the header's role pill once a page knows more than the signer
 * lists can tell (e.g. the overview reads the holding and finds it locked).
 */
export function showRoleInHeader(role: RoleKind): void {
  const pill = document.getElementById('header-role')
  const dot = document.getElementById('header-role-dot')
  const label = document.getElementById('header-role-label')
  if (!pill || !dot || !label) return
  dot.dataset.role = role
  label.textContent = ROLE_LABEL[role]
}

/**
 * Wires up the header's "Connect passkey" button, role pill and disconnect
 * control, plus every `[data-connect]` button. Call once, from Layout.astro.
 */
export function initConnectHeader(): void {
  const button = document.getElementById('header-connect') as HTMLButtonElement | null
  const pill = document.getElementById('header-role')
  const disconnect = document.getElementById('header-disconnect')
  if (!button || !pill || !disconnect) return

  document.addEventListener('click', (event) => {
    const target = event.target instanceof Element ? event.target.closest('[data-connect]') : null
    if (!target) return
    event.preventDefault()
    connectFromClick(target instanceof HTMLButtonElement ? target : null)
  })

  disconnect.addEventListener('click', () => {
    clearStoredAddress()
    notify(null)
  })

  onConnectionChange((address) => {
    button.hidden = Boolean(address)
    disconnect.hidden = !address
    pill.hidden = true
    if (!address) return
    loadPublicConfig()
      .then((config) => showRoleInHeader(signerRole(config, address)))
      .catch(() => showRoleInHeader('investor'))
      .finally(() => {
        // A disconnect may have landed while the config was loading.
        pill.hidden = getStoredAddress() !== address
      })
  })
}
