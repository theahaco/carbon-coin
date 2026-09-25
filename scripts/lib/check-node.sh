#!/usr/bin/env bash
# Local funding uses the published genesis seed, so require an isolated node.
source scripts/lib/environment.sh
xrpl rpc server_info --url "$URL" |
  jq -e '.info | (.network_id // 0) == 0 and .validation_quorum == 0 and .peers == 0' >/dev/null || {
    echo "Start a standalone node with bash scripts/start.sh." >&2
    exit 1
  }
