#!/usr/bin/env bash
# Build the pinned CLI until upstream publishes an installable release.
set -euo pipefail
repository=$(jq -er .repository cli.json)
revision=$(jq -er .commit cli.json)
directory=.prototype/xrpl-rust
mkdir -p .prototype
if [[ ! -d "$directory" ]]; then
  git clone --no-checkout --filter=blob:none "$repository" "$directory"
elif [[ -n "$(git -C "$directory" status --porcelain)" ]]; then
  echo "Save the local changes in $directory before running setup." >&2
  exit 1
fi
git -C "$directory" fetch --depth=1 origin "$revision"
git -C "$directory" checkout --detach "$revision"
cp cli/Cargo.lock "$directory/Cargo.lock"
cargo build --manifest-path "$directory/Cargo.toml" --locked --release -p xrpl-cli
echo "CLI ready. Start the walkthrough with bash scripts/start.sh."
