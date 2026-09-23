# Security TODO

Shortcuts taken for the public XRPL **testnet** demo. None of them is acceptable
outside testnet. Tracking issue: #11.

Current testnet deployment (see `web/public/deployment.json`):

- MPT issuance `0140588A60AD414AC57B9EE936049173E9CF215CB1BA2DE9` (`HQUAY`)
- Issuer (the Register): `r9FBRP7L5gnqG7LiHw1SqDwZ14V9rXhEHY`
- Governance (the Dealing Desk): `rf8KiuvfVqZ3GkwmQTUCyWySAW1Pv5qEVA`

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
3. **The Phase 1 issuance has no `RequireAuth`.** Its flags are CanLock,
   CanTransfer and CanClawback (`98`), so holding is open: any account can
   self-authorize and receive `HQUAY`, with no investor allow-list.
   `RequireAuth` is fixed at issuance, so adding it (Phase 2) needs another
   re-issue.

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
