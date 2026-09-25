#!/usr/bin/env bash
source scripts/lib/environment.sh

if [[ -e "$XRPL_DATA_DIR" ]]; then
  echo "Demo keys already exist. See README.md for starting a fresh run." >&2
  exit 1
fi
mkdir -p "$DEMO_DIR"

# Three accounts, with separate sets of three signers for issuer and governance.
# Keys are saved in the CLI's encrypted store before any accounts are funded.
for name in issuer governance holder \
  issuer_signer_1 issuer_signer_2 issuer_signer_3 \
  governance_signer_1 governance_signer_2 governance_signer_3
do
  xrpl key generate "$name" --algorithm ed25519
  xrpl account add "$name" --key "$name" --network-id 0
done

# Import standalone's published genesis key and give its account a name too.
printf '%s\n' snoPBrXtMeMyMHUVTgbuqAfg1SUTb |
  xrpl key add genesis --seed-stdin --yes
xrpl account add genesis --key genesis --network-id 0
