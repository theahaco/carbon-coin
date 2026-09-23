# Security TODO

Shortcuts taken for the public XRPL **testnet** demo. None of them is acceptable
outside testnet. Tracking issues: #11 (Phase 1), #14 (Phase 2).

Current testnet deployment (see `web/public/deployment.json`):

- MPT issuance `014065D7B11826B116E4B189DDE0A405680FEFED641D1DDC` (`HQUAY`),
  flags `102` (RequireAuth, CanLock, CanTransfer, CanClawback), AssetScale 3
- Issuer (the Register): `rH9PYrGRAfLJ3kJCPFrdHLULXf6yQMiw4y`
- Governance (the Dealing Desk): `rJZLs3cdQnHuf3fJPhC2bo3NghUbG7KWWB`

The Phase 1 issuance `0140588A60AD414AC57B9EE936049173E9CF215CB1BA2DE9`
(issuer `r9FBRP7L5gnqG7LiHw1SqDwZ14V9rXhEHY`, flags `98`, no `RequireAuth`)
stays on testnet, unused, with nothing outstanding.

## Testnet shortcuts in place

1. **The signer lists reuse earlier testnet keys.** Both 2-of-3 signer lists
   reuse the six signer addresses of the previous testnet deployment, so the
   same keyholders keep operating. Some of those addresses are placeholder
   wallets whose seeds live on a developer machine, not in any custody
   solution.
2. **The issuer and governance master seeds are kept locally.** The setup
   scripts write both master seeds to the gitignored `.deployment.json` on the
   machine that ran them. Both master keys are disabled on-ledger
   (`lsfDisableMaster`, no regular key), so those seeds can no longer sign for
   either account. Still treat the file as key material: never share or
   commit it.
3. **The issuer's master key stayed enabled for one extra transaction.**
   With `RequireAuth`, the Dealing Desk has to be admitted before it can
   receive units. The setup script kept the issuer's throwaway master key
   enabled after `MPTokenIssuanceCreate` and `SignerListSet`, used it for one
   more transaction, the admission of the Dealing Desk (`MPTokenAuthorize`
   with `Holder`, memo `admission` / `bootstrap: governance account`), then
   disabled it. While it was enabled (ledgers 20997593 to 20997604), that
   single key could sign for the issuer on its own, alongside the signer
   list. The evidence that it signed nothing else is the public trail: the
   issuer account's history shows exactly four transactions (create, signer
   list, admission, disable).

## Resolved

- **`RequireAuth`** (Phase 1 shortcut, resolved by the Phase 2 re-issue). The
  current issuance sets it, so a holder needs the Register's admission
  (`MPTokenAuthorize` with `Holder`) before it can receive units. Which
  wallets get admitted is still decided off-ledger; the ledger records the
  admission and its memo.

## Before any non-testnet use

- Institutional custody (HSM or MPC) for every signing key, instead of
  browser or developer-machine keys.
- Fresh signer sets generated for the purpose, with nobody on both the issuer
  and the governance lists.
- A weighted signer list if one seat must approve every transaction (for
  example quorum 3, with the mandatory seat at weight 2 and the other two at
  weight 1). Today's lists are equal-weight 2-of-3, so any two signers suffice.
- A fresh issuance with the flags the product needs at issuance time
  (`RequireAuth` at least), since they can't be changed afterwards.
- Disable the issuer's master key as soon as its signer list is set, and admit
  the Dealing Desk through the Register's multisig rather than a single key.
