#!/usr/bin/env bash
set -euo pipefail
# The standalone ledger is disposable; stopping it removes its container.
docker compose -p carbon-coin-devnet -f devnet/compose.yml down
