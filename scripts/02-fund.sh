#!/usr/bin/env bash
source scripts/lib/environment.sh
bash scripts/lib/check-node.sh

# Standalone's public genesis account supplies 1,000 XRP to each account.
# XRP amounts are in drops: 1 XRP = 1,000,000 drops.
# The six signer addresses do not need their own funded accounts.
for destination in "$ISSUER" "$GOVERNANCE" "$HOLDER"
do
  xrpl tx new payment \
    --account rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh \
    --destination "$destination" --amount 1000000000 |
    xrpl tx autofill --url "$URL" |
    XRPL_SEED=snoPBrXtMeMyMHUVTgbuqAfg1SUTb xrpl tx sign |
    xrpl tx submit --url "$URL" --wait --accept-ledger
done
