#!/usr/bin/env bash
source scripts/lib/environment.sh

# Create a token with whole units, transferable, lockable and clawback-enabled.
# @file asks the CLI to encode the metadata file; no hex encoding is needed here.
xrpl tx new mptoken-issuance-create --account issuer \
  --mptoken-metadata @demo/token-metadata.json \
  --flag tfMPTCanTransfer --flag tfMPTCanLock --flag tfMPTCanClawback |
  xrpl tx autofill --url "$URL" |
  xrpl tx sign --sign-with issuer |
  xrpl tx submit --url "$URL" --wait --accept-ledger > "$DEMO_DIR/issuance.json"
bash scripts/lib/save-issuance-id.sh

# Install a 2-of-3 quorum before disabling the master key.
xrpl tx new signer-list-set --account issuer --signer-quorum 2 \
  --signer-entry "$(xrpl account show issuer_signer_1 --address):1" \
  --signer-entry "$(xrpl account show issuer_signer_2 --address):1" \
  --signer-entry "$(xrpl account show issuer_signer_3 --address):1" |
  xrpl tx autofill --url "$URL" |
  xrpl tx sign --sign-with issuer |
  xrpl tx submit --url "$URL" --wait --accept-ledger

# From now on, issuer transactions require two of the signers above.
xrpl tx new account-set --account issuer --set-flag asfDisableMaster |
  xrpl tx autofill --url "$URL" |
  xrpl tx sign --sign-with issuer |
  xrpl tx submit --url "$URL" --wait --accept-ledger
