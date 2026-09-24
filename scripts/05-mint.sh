#!/usr/bin/env bash
source scripts/lib/environment.sh

# Edit this amount to experiment. Sending from the issuer creates new units.
AMOUNT=1000

# Autofill budgets the fee for two signatures. Each sign command adds one.
xrpl tx new payment --account issuer --destination "$GOVERNANCE" \
  --amount "$AMOUNT/$MPT_ID" --memo "CLI demo mint" |
  xrpl tx autofill --url "$URL" --signers 2 |
  xrpl tx sign --multisign --sign-with issuer_signer_1 |
  xrpl tx sign --multisign --sign-with issuer_signer_2 |
  xrpl tx submit --url "$URL" --wait --accept-ledger
