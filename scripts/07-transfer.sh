#!/usr/bin/env bash
source scripts/lib/environment.sh

AMOUNT=250

# Governance sends existing units, using its own independent 2-of-3 quorum.
xrpl tx new payment --account governance --destination "$HOLDER" \
  --amount "$AMOUNT/$MPT_ID" |
  xrpl tx autofill --url "$URL" --signers 2 |
  xrpl tx sign --multisign --sign-with governance_signer_1 |
  xrpl tx sign --multisign --sign-with governance_signer_2 |
  xrpl tx submit --url "$URL" --wait --accept-ledger
