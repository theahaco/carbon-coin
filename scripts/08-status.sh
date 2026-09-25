#!/usr/bin/env bash
source scripts/lib/environment.sh

# Queries do not sign transactions or change the ledger.
xrpl account info --account issuer --signer-lists --ledger-index validated --url "$URL"
xrpl account info --account governance --signer-lists --ledger-index validated --url "$URL"
xrpl account objects --account governance --type mptoken --ledger-index validated --url "$URL"
xrpl account objects --account holder --type mptoken --ledger-index validated --url "$URL"
xrpl rpc ledger_entry --param "mpt_issuance=$MPT_ID" \
  --param ledger_index=validated --url "$URL"
