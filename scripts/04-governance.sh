#!/usr/bin/env bash
source scripts/lib/environment.sh

# Governance opts in to holding the token before handing control to its quorum.
xrpl tx new mptoken-authorize --account governance \
  --mptoken-issuance-id "$MPT_ID" |
  xrpl tx autofill --url "$URL" |
  xrpl tx sign --sign-with governance |
  xrpl tx submit --url "$URL" --wait --accept-ledger

xrpl tx new signer-list-set --account governance --signer-quorum 2 \
  --signer-entry "$(xrpl account show governance_signer_1 --address):1" \
  --signer-entry "$(xrpl account show governance_signer_2 --address):1" \
  --signer-entry "$(xrpl account show governance_signer_3 --address):1" |
  xrpl tx autofill --url "$URL" |
  xrpl tx sign --sign-with governance |
  xrpl tx submit --url "$URL" --wait --accept-ledger

xrpl tx new account-set --account governance --set-flag asfDisableMaster |
  xrpl tx autofill --url "$URL" |
  xrpl tx sign --sign-with governance |
  xrpl tx submit --url "$URL" --wait --accept-ledger
