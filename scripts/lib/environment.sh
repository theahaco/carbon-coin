#!/usr/bin/env bash
# Shared setup only; the numbered scripts contain every transaction command.
# Run the scripts from the repository root.
set -euo pipefail
umask 077

export PATH="$PWD/.prototype/xrpl-rust/target/release:$PATH"
DEMO_DIR="${DEMO_DIR:-$PWD/.demo}"
export XRPL_DATA_DIR="$DEMO_DIR/keys"
export XRPL_CONFIG_DIR="$DEMO_DIR/config"
# Public, disposable demo credentials. Never use this store for real assets.
export XRPL_PASSPHRASE=local-demo-only
URL="${XRPL_URL:-http://127.0.0.1:5005}"
case "$URL" in
  http://127.0.0.1:*|http://localhost:*) ;;
  *) echo "This walkthrough requires a local standalone node." >&2; exit 1 ;;
esac
command -v xrpl >/dev/null || {
  echo "Run bash scripts/setup-cli.sh first." >&2
  exit 1
}

# These files contain public addresses and the token ID, never seeds.
if [[ -f "$DEMO_DIR/accounts.env" ]]; then
  # shellcheck disable=SC1091
  source "$DEMO_DIR/accounts.env"
fi
if [[ -f "$DEMO_DIR/issuance-id" ]]; then
  MPT_ID=$(cat "$DEMO_DIR/issuance-id")
  export MPT_ID
fi
