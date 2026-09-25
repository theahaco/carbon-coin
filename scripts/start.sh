#!/usr/bin/env bash
set -euo pipefail
docker compose -p carbon-coin-devnet -f devnet/compose.yml up -d --wait
