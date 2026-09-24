#!/usr/bin/env bash
source scripts/lib/environment.sh

# A recipient must opt in before it can receive this token.
xrpl tx new mptoken-authorize --account holder \
  --mptoken-issuance-id "$MPT_ID" |
  xrpl tx autofill --url "$URL" |
  xrpl tx sign --sign-with holder |
  xrpl tx submit --url "$URL" --wait --accept-ledger
