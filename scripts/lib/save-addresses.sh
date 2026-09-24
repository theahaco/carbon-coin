#!/usr/bin/env bash
# Plumbing: turn the CLI's JSON key records into ordinary Bash variables.
# The CLI currently returns JSON rather than a bare address.
source scripts/lib/environment.sh

for name in issuer governance holder \
  issuer_signer_1 issuer_signer_2 issuer_signer_3 \
  governance_signer_1 governance_signer_2 governance_signer_3
do
  address=$(xrpl key show "$name" --json | jq -er '.classic_address')
  xrpl account add "$name" --address "$address" --network-id 0 \
    --key "$name" --default-signer "$name"
  variable=$(printf '%s' "$name" | tr '[:lower:]' '[:upper:]')
  printf 'export %s=%s\n' "$variable" "$address" >> "$DEMO_DIR/accounts.env"
done
