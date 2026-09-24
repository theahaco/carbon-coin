#!/usr/bin/env bash
# Plumbing: keep the validated issuance ID for the remaining scripts.
source scripts/lib/environment.sh
jq -er '.meta.mpt_issuance_id | select(test("^[A-Fa-f0-9]{48}$"))' \
  "$DEMO_DIR/issuance.json" > "$DEMO_DIR/issuance-id"
echo "Token ID: $(cat "$DEMO_DIR/issuance-id")"
