#!/usr/bin/env bash
# jq expressions intentionally use single quotes.
# shellcheck disable=SC2016
set -euo pipefail
umask 077

ROOT=$(cd "$(dirname "$0")/.." && pwd)
# shellcheck source=scripts/token-common.sh
source "$ROOT/scripts/token-common.sh"
COMMAND="${1:-status}"; shift || true
export XRPL_BIN="${XRPL_BIN:-$ROOT/.prototype/xrpl-rust/target/release/xrpl}"
export XRPL_NETWORK="${XRPL_NETWORK:-local}"
case "$XRPL_NETWORK" in
  local) NETWORK_ID=0; DEFAULT_URL=http://localhost:5005 ;;
  testnet) NETWORK_ID=1; DEFAULT_URL=https://s.altnet.rippletest.net:51234 ;;
  *) fail "XRPL_NETWORK must be local or testnet." ;;
esac
XRPL_URL="${XRPL_URL:-$DEFAULT_URL}"
XRPL_FAUCET_URL="${XRPL_FAUCET_URL:-https://faucet.altnet.rippletest.net/accounts}"
STATE="${TOKEN_STATE_FILE:-$ROOT/.deployment.json}"
WORK=$(mktemp -d)
LOCKED=false
cleanup() {
  rm -rf "$WORK"
  if [[ "$LOCKED" == true ]]; then rmdir "$STATE.lock"; fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
case "$COMMAND" in
  setup:issuer|setup:governance|mint|redistribute|deployment:import)
    mkdir "$STATE.lock" 2>/dev/null || fail "Deployment is locked: $STATE.lock"
    LOCKED=true
    ;;
  status|web:sync-config) ;;
  *) fail "Usage: token.sh setup:issuer|setup:governance|mint AMOUNT [PERIOD] [--force]|redistribute ADDRESS AMOUNT|status|web:sync-config|deployment:import" ;;
esac
if [[ ! -f "$STATE" ]]; then
  case "$COMMAND" in
    setup:issuer)
      prefix="carbon-$XRPL_NETWORK-$(od -An -N8 -tx1 /dev/urandom | tr -d ' \n')"
      jq -n --arg network "$XRPL_NETWORK" --arg prefix "$prefix" \
        '{version:2,network:$network,keyPrefix:$prefix,mintedPeriods:[],steps:{}}' > "$STATE"
      ;;
    *) fail "No deployment at $STATE. Run npm run setup:issuer first." ;;
  esac
fi
[[ "$(read_state '.network')" == "$XRPL_NETWORK" ]] ||
  fail "Deployment belongs to another network. Select its XRPL_NETWORK or a different TOKEN_STATE_FILE."
if [[ "$COMMAND" != deployment:import ]]; then
  [[ "$(jq -r '.version // 1' "$STATE")" == 2 ]] ||
    fail "Legacy deployment contains plaintext seeds. Run npm run deployment:import first."
fi
if [[ "$COMMAND" != web:sync-config ]]; then
  [[ -x "$XRPL_BIN" ]] || fail "Missing xrpl CLI. Run npm run cli:setup, or set XRPL_BIN."
fi

token_metadata() {
  jq -n -f "$ROOT/scripts/metadata.jq" > "$WORK/metadata.json"
  [[ "$(wc -c < "$WORK/metadata.json")" -le 1024 ]] || fail "MPTokenMetadata exceeds 1024 bytes."
}

setup_issuer() {
  done_step issuer-ready && { note "Issuer already configured: $(address issuer)"; return; }
  token_metadata
  check_network
  create_account issuer "${ISSUER_SIGNER_ADDRESSES:-}"
  fund issuer
  if ! done_step issuer-issuance; then
    xrpl tx new mptoken-issuance-create --account "$(address issuer)" \
      --mptoken-metadata "@$WORK/metadata.json" \
      --flag tfMPTCanTransfer --flag tfMPTCanLock --flag tfMPTCanClawback > "$WORK/draft.json"
    send issuer-issuance single issuer
    # The validated create transaction supplies both the ID and ledger outcome.
    jq -e '.meta.mpt_issuance_id | type == "string" and test("^[A-Fa-f0-9]{48}$")' <<< "$RESPONSE" >/dev/null
    complete issuer-issuance '.mptIssuanceId = $result.meta.mpt_issuance_id'
  fi
  handover issuer
  note "Issuer ready: $(address issuer); MPT $(read_state '.mptIssuanceId')"
}

setup_governance() {
  require_ready issuer
  done_step governance-ready && { note "Governance already configured: $(address governance)"; return; }
  check_network
  create_account governance "${GOVERNANCE_SIGNER_ADDRESSES:-}"
  fund governance
  if ! done_step governance-authorized; then
    xrpl tx new mptoken-authorize --account "$(address governance)" \
      --mptoken-issuance-id "$(read_state '.mptIssuanceId')" > "$WORK/draft.json"
    send governance-authorized single governance
    complete governance-authorized
  fi
  handover governance
  note "Governance ready: $(address governance)"
}

amount() {
  [[ "$1" =~ ^[0-9]+$ ]] || fail "Amount must be a whole non-negative integer."
  # Compare decimal strings; jq numbers cannot represent the MPT upper bound.
  local normalized
  normalized=$(sed 's/^0*//; s/^$/0/' <<< "$1")
  # shellcheck disable=SC2071
  [[ ${#normalized} -lt 19 || ( ${#normalized} -eq 19 && ! "$normalized" > 9223372036854775807 ) ]] ||
    fail "Amount exceeds the MPT maximum (9223372036854775807)."
  printf '%s' "$normalized"
}

mint() {
  require_ready issuer
  require_ready governance
  local force=false positional=() arg units period label memo
  for arg in "$@"; do
    case "$arg" in
      --force) force=true ;;
      --*) fail "Unknown mint option: $arg" ;;
      *) positional+=("$arg") ;;
    esac
  done
  [[ ${#positional[@]} -ge 1 && ${#positional[@]} -le 2 ]] || fail "Usage: mint AMOUNT [PERIOD] [--force]"
  units=$(amount "${positional[0]}")
  period="${positional[1]:-$(date +%Y)}"
  [[ -n "$period" ]] || fail "Mint period must not be empty."
  if [[ "$force" == false ]] && jq -e --arg period "$period" '(.mintedPeriods // []) | index($period) != null' "$STATE" >/dev/null; then
    fail "Period $period was already minted. Use --force for an intentional correction."
  fi
  check_network
  label=$(jq -cn --arg amount "$units" --arg period "$period" --arg force "$force" '{action:"mint",amount:$amount,period:$period,force:$force}')
  memo=$(jq -cn --arg type "$(printf 'mint-period' | hex)" --arg data "$(printf '%s' "$period" | hex)" \
    '[{Memo:{MemoType:$type,MemoData:$data}}]')
  xrpl tx new payment --account "$(address issuer)" --destination "$(address governance)" \
    --amount "$units/$(read_state '.mptIssuanceId')" --field "Memos=$memo" > "$WORK/draft.json"
  send "$label" multisign issuer
  save --arg period "$period" --argjson result "$RESPONSE" \
    '.mintedPeriods = ((.mintedPeriods // []) + [$period] | unique) | .lastMintHash = $result.hash | del(.pending)'
  note "Mint validated: $(jq -r '.hash' <<< "$RESPONSE")"
}

redistribute() {
  [[ $# -eq 2 ]] || fail "Usage: redistribute ADDRESS AMOUNT"
  require_ready governance
  local units label
  units=$(amount "$2")
  check_network
  label=$(jq -cn --arg destination "$1" --arg amount "$units" '{action:"redistribute",destination:$destination,amount:$amount}')
  xrpl tx new payment --account "$(address governance)" --destination "$1" \
    --amount "$units/$(read_state '.mptIssuanceId')" > "$WORK/draft.json"
  send "$label" multisign governance
  save --argjson result "$RESPONSE" '.lastRedistributionHash = $result.hash | del(.pending)'
  note "Redistribution validated: $(jq -r '.hash' <<< "$RESPONSE")"
}

status() {
  check_network
  jq '{network,mptIssuanceId,mintedPeriods,pendingOperation:.pending.label}' "$STATE"
  if jq -e '.mptIssuanceId' "$STATE" >/dev/null; then
    rpc ledger_entry --param "mpt_issuance=$(read_state '.mptIssuanceId')" --param ledger_index=validated
  fi
  local role
  for role in issuer governance; do
    if jq -e --arg role "$role" '.[$role]' "$STATE" >/dev/null; then
      note "$role: $(address "$role")"
      xrpl account info --account "$(address "$role")" --signer-lists --ledger-index validated --url "$XRPL_URL" --json
      if [[ "$role" == governance ]] && done_step governance-authorized; then
        rpc ledger_entry --param "mptoken=$(jq -cn --arg account "$(address governance)" --arg id "$(read_state '.mptIssuanceId')" '{account:$account,mpt_issuance_id:$id}')" --param ledger_index=validated
      fi
    fi
  done
}

sync_public_config() {
  token_metadata
  local output="${TOKEN_PUBLIC_CONFIG:-$ROOT/web/public/deployment.json}"
  jq -f "$ROOT/scripts/public-config.jq" "$STATE" > "$WORK/public.json"
  # Use a sibling temporary file so publication is atomic on the same filesystem.
  cp "$WORK/public.json" "$output.tmp"
  chmod 644 "$output.tmp"
  mv "$output.tmp" "$output"
  note "Wrote $output"
}

import_deployment() {
  [[ "$(jq -r '.version // 1' "$STATE")" != 2 ]] || { note "Deployment already imported."; return; }
  # Keep the legacy file until every seed has been enrolled and address-checked.
  if ! jq -e '.keyPrefix' "$STATE" >/dev/null; then
    save --arg prefix "carbon-$XRPL_NETWORK-$(od -An -N8 -tx1 /dev/urandom | tr -d ' \n')" '.keyPrefix=$prefix'
  fi
  local role index key addr selector count
  for role in issuer governance; do
    jq -e --arg role "$role" '.[$role]' "$STATE" >/dev/null || continue
    count=$(read_state ".$role.signers | length")
    for ((index=-1; index<count; index++)); do
      if [[ "$index" -lt 0 ]]; then
        selector=".$role"; key="$(read_state '.keyPrefix')-$role"
      else
        selector=".$role.signers[$index]"; key="$(read_state '.keyPrefix')-$role-signer-$index"
      fi
      [[ -n "$(jq -r "$selector.seed // \"\"" "$STATE")" ]] || continue
      addr=$(read_state "$selector.address")
      if ! xrpl key show "$key" --json >/dev/null 2>&1; then
        jq -r "$selector.seed" "$STATE" | xrpl key add "$key" --seed-stdin --yes >/dev/null
      fi
      assert_key "$key" "$addr"
    done
  done
  save '
    .keyPrefix as $prefix |
    reduce ["issuer","governance"][] as $role (.;
      if .[$role] then
        .[$role] |= {
          address, quorum, key:($prefix+"-"+$role),
          signers:(.signers | to_entries | map(
            {address:.value.address} +
            (if (.value.seed // "") != "" then {key:($prefix+"-"+$role+"-signer-"+(.key|tostring))} else {} end)))
        } |
        .steps[$role+"-ready"] = true |
        .steps[$role+"-funded"] = true |
        .steps[$role+"-signer-list"] = true |
        .steps[(if $role == "issuer" then "issuer-issuance" else "governance-authorized" end)] = true
      else . end) | .version=2'
  note "Imported deployment. Seeds now live in the encrypted CLI store."
}

case "$COMMAND" in
  setup:issuer) setup_issuer ;;
  setup:governance) setup_governance ;;
  mint) mint "$@" ;;
  redistribute) redistribute "$@" ;;
  status) status ;;
  web:sync-config) sync_public_config ;;
  deployment:import) import_deployment ;;
esac
