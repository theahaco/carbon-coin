# xrpl-token

A simple fungible token on the XRP Ledger, built on the native **MPToken**
standard (not classic trust-line Issued Currencies). New supply is minted
annually via a multisig-gated issuer account and sent to a multisig-gated
governance account, which will later decide fund allocation.


## Aha DevX prototype

This branch uses [the aha xrpl.js prototype (PR #57)](https://github.com/theahaco/xrpl.js/pull/57),
pinned to the commit in [`prototype.json`](prototype.json). Run `npm run prototype:setup`
before installing this app. It creates an ignored `.prototype/xrpl.js` checkout and
builds all seven SDK packages; both the CLI and browser resolve that same build.
No npm release or developer-specific checkout path is needed. CI uses the same setup.
To update the SDK, change the commit pin, rerun setup, and refresh both lockfiles.

Local signing uses `WalletClient.tx` and throws unless the transaction validates
successfully. Ledger reads use the discoverable `client.command` API with inferred
response types. GhostSig still owns browser keys and the multi-person ceremony;
we never instantiate a local signing wallet for a GhostSig address.

See [the migration PR](https://github.com/theahaco/carbon-coin/pull/9) for before/after
code, remaining boundaries, related SDK PRs, and validation.

## Design summary

- **Token standard**: XRPL native MPToken (`MPTokenIssuanceCreate` /
  `MPTokenAuthorize` / `Payment`).
- **Supply**: open-ended (no `MaximumAmount`), whole units only (`AssetScale`
  omitted) — no decimals, no floating-point conversion anywhere.
- **Issuance flags**: transferable, lockable (freeze), clawback-able. Not
  allow-listed (`tfMPTRequireAuth` is not set) — any account can hold the
  token once it self-authorizes.
- **Issuer account**: the MPT issuance itself is a single-sig bootstrap
  action, signed with the account's still-active throwaway master key. The
  account is then established as a 2-of-3 multisig and its master key is
  disabled immediately after — so from that point on, the annual mint,
  lock/unlock, and clawback are all provably multisig-only actions.
- **Governance account** likewise self-authorizes to hold the MPT as a
  single-sig bootstrap action before its master key is disabled; from then
  on it's a 2-of-3 multisig, independent of whatever real-world governance
  process eventually decides where funds go.
- Both 2-of-3 signer sets are **placeholders** for local/Testnet development
  — replace them with real keys before any production use.

See `devnet/rippled.cfg` and `src/lib/` for implementation details and
inline rationale. All local-network tooling (starting/stopping the
stand-alone node, keeping its ledger advancing, the `devnet:up`/`devnet:down`
CLI) lives under `devnet/`, separate from the token/XRPL application logic
in `src/`.

## Prerequisites

- Node.js 22.12+ (required by Astro, used for the web frontend)
- Docker — only required for `XRPL_NETWORK=local` (this project was
  developed and tested against [colima](https://github.com/abiosoft/colima);
  Docker Desktop should also work). Skip it entirely by using
  `XRPL_NETWORK=testnet` instead; see [Networks](#networks) below.

## Setup

```sh
npm run prototype:setup   # builds the exact aha SDK commit in prototype.json
npm ci
npm --prefix web ci
cp .env.example .env
```

Edit `.env` to set your token's identity (`TOKEN_TICKER`, `TOKEN_NAME`,
etc.) and to select a network via `XRPL_NETWORK` (`local` or `testnet`).

## Networks

Switching networks is a single `.env` change:

- **`XRPL_NETWORK=local`** (default) — a disposable, local, stand-alone
  XRPL node running in Docker. No real money, no faucet rate limits, no
  reliance on Testnet being up. **Requires Docker.**
- **`XRPL_NETWORK=testnet`** — the public XRPL Testnet, funded via the
  public faucet. **No Docker required** — this is the escape hatch if you
  don't have (or don't want) a container runtime installed. Trade-offs:
  faucet rate limits, real (if slow, ~4s) ledger close times instead of
  instant on-demand ones, ledger state shared with the rest of the public
  Testnet, and periodic full resets by Ripple (see
  [Security notes](#security-notes)).

An optional `XRPL_WS_URL` overrides the WebSocket endpoint for either
network.

### Running the local network

```sh
npm run devnet:up    # starts a stand-alone rippled node + a background ledger-advance loop
npm run devnet:down  # stops both
```

Stand-alone mode never closes ledgers on its own, so `devnet:up` also spawns
a small detached background process that calls the admin `ledger_accept` RPC
every 500ms — without it, submitted transactions would never be confirmed.
Both the container and the background process are tracked in `.devnet.json`
(gitignored); `devnet:down` reads it to stop both and removes it. If you
forget to run `devnet:down` (e.g. after killing the terminal), both will
keep running until stopped manually.

The local node's genesis account (address and secret are XRPL's
well-known, publicly-documented stand-alone values — never use them for
anything beyond local development) holds all XRP and is used to fund
freshly-generated wallets directly, so no faucet is needed locally.

## Usage

With the local network running (`npm run devnet:up`) or `XRPL_NETWORK=testnet`
set:

```sh
npm run setup:issuer                    # funds + configures the issuer, creates the MPT
npm run setup:governance                # funds + configures governance, authorizes it to hold the MPT
npm run mint -- <amount> [period]       # multisig-signed mint to governance (period defaults to the current year)
npm run redistribute -- <address> <amount>  # multisig-signed Payment from governance to a recipient
npm run status                          # prints issuance, balances, and signer list configuration
```

All state (generated addresses, signer seeds, the MPT issuance ID, and a
record of which periods have already been minted) is persisted to
`.deployment.json`, which is gitignored. Delete it (or specific fields
within it) to redo a step from scratch.

`mint` refuses to mint twice for the same period unless you pass `--force`,
as a safety net against accidental double-issuance:

```sh
npm run mint -- 100000 2026          # first mint for 2026
npm run mint -- 100000 2026          # refused: already minted for 2026
npm run mint -- 100000 2026 --force  # explicit override, e.g. for a correction
```

## Testing

```sh
npm run test:integration
```

This runs the full Vitest suite, which spins up a fresh, disposable
stand-alone rippled container per test file (via `testcontainers`) and
exercises real transactions against it — no mocking of XRPL behavior. It
covers:

- MPT issuance creation (flags, whole-unit scale, no supply cap, metadata)
- Multisig-gated minting, including insufficient-signature, disabled-master-
  key, and unauthorized-destination failure cases
- Governance setup and multisig redistribution
- Issuer lock/unlock and clawback
- Network-selection logic for both `local` and `testnet`

```sh
npm run typecheck
```

## Web frontend

`web/` is a static, frontend-only Astro site that lets issuer/governance
multisig members run real, [GhostSig](https://ghostsig.dev)-signed minting
and redistribution ceremonies directly from a browser — no server, no
seeds held anywhere. General visitors can connect, self-authorize, view live
stats, and send Gton they already hold.

GhostSig only understands XRPL `testnet`/`devnet`/`mainnet`, so the web demo
always targets **XRPL Testnet**, regardless of the CLI's `XRPL_NETWORK`
setting. For "my address is a signer" to ever be true in the browser, the
issuer/governance signer lists need at least one real, externally-supplied
address (e.g. your own GhostSig address) — see `ISSUER_SIGNER_ADDRESSES` /
`GOVERNANCE_SIGNER_ADDRESSES` in `.env.example`.

```sh
npm run setup:issuer      # with XRPL_NETWORK=testnet and ISSUER_SIGNER_ADDRESSES set
npm run setup:governance  # likewise, with GOVERNANCE_SIGNER_ADDRESSES set
npm run web:sync-config   # regenerates web/public/deployment.json (addresses only, never seeds)
npm run web:dev           # or web:build / web:typecheck
```

`web/public/deployment.json` is a committed, regenerate-on-demand static
asset containing only non-secret fields (addresses, quorum, token identity)
— `sync-public-config.ts` refuses to write anything containing a `seed` key.
See `web/src/lib/ghostsig.ts` for the vendored GHOSTSIG popup protocol client
(adapted from `ghostsig/sdk/popup.ts`) that the site signs everything through.

## Security notes

- All signer seeds (issuer and governance) are sensitive secrets. They're
  stored in `.deployment.json`, which is gitignored, but treat that file
  with the same care as any private key material.
- The issuer's and governance's 2-of-3 signer sets are **local/Testnet
  placeholders**. Real signer accounts/keys must replace them before any
  mainnet use. If a signer set is ever fully lost with no rotation path,
  that account becomes permanently locked out of its own powers/funds.
- Freeze and clawback are powerful, centralized controls, included
  deliberately for this token. Document them clearly for any future holders
  or auditors.
- `SignerListSet` replaces an account's entire signer list; there's no
  incremental add/remove. Rotating signers requires meeting the *current*
  quorum to authorize the replacement list.
- Ripple periodically resets XRPL Testnet entirely. A reset invalidates
  `.deployment.json`; just rerun the setup scripts to redeploy.
- The local stand-alone network's genesis secret is publicly known by
  design (anyone can spin up their own local node) — never use it for
  anything beyond local development funding.
