#!/usr/bin/env bash
# jq expressions intentionally use single quotes.
# shellcheck disable=SC2016
# Application state and composition only. xrpl owns every ledger/crypto operation.

fail() { printf '%s\n' "$*" >&2; exit 1; }
note() { printf '%s\n' "$*" >&2; }
xrpl() { "$XRPL_BIN" "$@"; }
read_state() { jq -er "$1" "$STATE"; }
save() {
  jq "$@" "$STATE" > "$STATE.tmp"
  mv "$STATE.tmp" "$STATE"
}
done_step() { jq -e --arg step "$1" '.steps[$step] == true' "$STATE" >/dev/null; }
complete() {
  save --arg step "$1" --argjson result "$RESPONSE" "${2:-.} | .steps[\$step] = true | del(.pending)"
}
rpc() { xrpl rpc "$@" --url "$XRPL_URL"; }
address() { read_state ".$1.address"; }
hex() { LC_ALL=C od -An -v -tx1 | tr -d ' \n' | tr 'abcdef' 'ABCDEF'; }

check_network() {
  local info actual
  info=$(rpc server_info)
  actual=$(jq -r '.info.network_id // 0' <<< "$info")
  [[ "$actual" == "$NETWORK_ID" ]] || fail "Node network_id=$actual; expected $NETWORK_ID for $XRPL_NETWORK."
  if [[ "$XRPL_NETWORK" == local ]]; then
    # server_info has no standalone boolean. A standalone node reports no
    # validators or peers; refuse a consensus network using the same network id.
    jq -e '.info.validation_quorum == 0 and .info.peers == 0' <<< "$info" >/dev/null ||
      fail "Local operations require an isolated node with no validation quorum or peers."
  fi
}

require_ready() {
  done_step "$1-ready" || fail "Run npm run setup:$1 first."
}

# Keys are saved encrypted before their addresses are put into deployment state.
# Stable ids let an interrupted enrolment recover the same key, never replace it.
identity() {
  local id="$1"
  if ! xrpl key show "$id" --json > "$WORK/key.json" 2>/dev/null; then
    xrpl key generate "$id" --algorithm ed25519 > "$WORK/key.json" || return $?
  fi
  jq -er '.classic_address | select(type == "string" and length > 0)' "$WORK/key.json"
}

assert_key() {
  local actual
  actual=$(xrpl key show "$1" --json | jq -er '.classic_address')
  [[ "$actual" == "$2" ]] || fail "Key $1 resolves to $actual, expected $2. Check XRPL_DATA_DIR."
}

# Save a signed transaction before submission. An interrupted command reuses those
# exact bytes; a different operation cannot accidentally consume its sequence.
# Call complete/save immediately after success to commit state and clear pending.
send() {
  local label="$1" mode="$2" subject="$3" pending key
  pending=$(jq -r '.pending.label // ""' "$STATE")
  if [[ -n "$pending" ]]; then
    [[ "$pending" == "$label" ]] || fail "Unresolved operation: $pending. Re-run that command first."
    jq '.pending.transaction' "$STATE" > "$WORK/signed.json"
  else
    if [[ "$mode" == single ]]; then
      key=$(read_state ".$subject.key")
      assert_key "$key" "$(address "$subject")"
      xrpl tx autofill --url "$XRPL_URL" "$WORK/draft.json" |
        xrpl tx sign --sign-with "$key" > "$WORK/signed.json"
    elif [[ "$mode" == genesis ]]; then
      # This seed is the public standalone genesis value, never a user secret.
      xrpl tx autofill --url "$XRPL_URL" "$WORK/draft.json" |
        XRPL_SEED=snoPBrXtMeMyMHUVTgbuqAfg1SUTb xrpl tx sign > "$WORK/signed.json"
    else
      local quorum count
      quorum=$(read_state ".$subject.quorum")
      jq -r --arg role "$subject" '.[$role].signers | map(select(.key != null)) | .[].key' "$STATE" > "$WORK/signers"
      count=$(wc -l < "$WORK/signers" | tr -d ' ')
      [[ "$count" -ge "$quorum" ]] || fail "Need $quorum local signers, found $count. Use the GhostSig browser ceremony."
      xrpl tx autofill --url "$XRPL_URL" --signers "$quorum" "$WORK/draft.json" > "$WORK/signed.json"
      count=0
      while IFS= read -r key; do
        [[ "$count" -lt "$quorum" ]] || break
        assert_key "$key" "$(jq -r --arg key "$key" --arg role "$subject" '.[$role].signers[] | select(.key == $key) | .address' "$STATE")"
        xrpl tx sign --multisign --sign-with "$key" "$WORK/signed.json" > "$WORK/next.json"
        mv "$WORK/next.json" "$WORK/signed.json"
        count=$((count + 1))
      done < "$WORK/signers"
    fi
    save --arg label "$label" --slurpfile tx "$WORK/signed.json" '.pending = {label:$label, transaction:$tx[0]}'
  fi
  # Transport/expiry uncertainty leaves pending intact. A validated failure
  # consumes the sequence without applying the operation, so a correction is safe.
  local code=0 found=false hash
  if [[ -n "$pending" ]]; then
    hash=$(xrpl tx hash "$WORK/signed.json" | jq -er '.')
    if rpc tx --param "transaction=$hash" > "$WORK/result.json" 2>/dev/null; then
      if jq -e '.validated == true' "$WORK/result.json" >/dev/null; then found=true; fi
    fi
  fi
  if [[ "$found" == false ]]; then
    if [[ "$XRPL_NETWORK" == local ]]; then
      xrpl tx submit --wait --accept-ledger --url "$XRPL_URL" "$WORK/signed.json" > "$WORK/result.json" || code=$?
    else
      xrpl tx submit --wait --url "$XRPL_URL" "$WORK/signed.json" > "$WORK/result.json" || code=$?
    fi
  fi
  if jq -e '.validated == true and (.meta.TransactionResult | type == "string" and . != "tesSUCCESS")' "$WORK/result.json" >/dev/null 2>&1; then
    save --slurpfile result "$WORK/result.json" '.lastFailedTransaction = $result[0] | del(.pending)'
    exit 3
  fi
  [[ "$code" -eq 0 ]] || exit "$code"
  jq -e '.validated == true and .meta.TransactionResult == "tesSUCCESS"' "$WORK/result.json" >/dev/null ||
    fail "Submission did not return validated success; the signed transaction remains pending."
  RESPONSE=$(cat "$WORK/result.json")
}

fund() {
  local role="$1" destination step
  step="$role-funded"
  done_step "$step" && return
  destination=$(address "$role")
  if [[ "$XRPL_NETWORK" == local ]]; then
    xrpl tx new payment --account rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh \
      --destination "$destination" --amount 1000000000 > "$WORK/draft.json"
    send "$step" genesis ""
  else
    # A faucet funds the already-enrolled address; it never creates our keys.
    # Avoid a second request if a previous run stopped after funding landed.
    if ! xrpl account info --account "$destination" --url "$XRPL_URL" --json > "$WORK/account.json" 2>"$WORK/account.err"; then
      if ! grep -q 'actNotFound' "$WORK/account.err"; then
        cat "$WORK/account.err" >&2
        fail "Could not determine whether $destination is funded."
      fi
      jq -n --arg destination "$destination" '{destination:$destination}' > "$WORK/faucet.json"
      curl --fail --silent --show-error --max-time 60 --header 'Content-Type: application/json' \
        --data-binary "@$WORK/faucet.json" "$XRPL_FAUCET_URL" > "$WORK/faucet-response.json"
    fi
    local attempt=0
    while [[ "$attempt" -lt 30 ]]; do
      attempt=$((attempt + 1))
      if xrpl account info --account "$destination" --url "$XRPL_URL" --ledger-index validated --json > "$WORK/account.json" 2>/dev/null; then
        break
      fi
      sleep 2
    done
    jq -e --arg address "$destination" '.account_data.Account == $address' "$WORK/account.json" >/dev/null ||
      fail "Faucet funding has not validated; rerun the setup command."
    RESPONSE='{}'
  fi
  complete "$step"
}

create_account() {
  local role="$1" presets="$2" key addr index count signers existing
  existing=$(jq -r --arg role "$role" '.[$role].address // ""' "$STATE")
  [[ -z "$existing" ]] || return 0
  # Validate external addresses and duplicates before generating anything.
  signers=$(jq -cn --arg values "$presets" '$values | split(",") | map(gsub("^\\s+|\\s+$";"")) | map(select(length>0))')
  count=$(jq 'length' <<< "$signers")
  [[ "$count" -le 3 ]] || fail "$role accepts at most three signer addresses."
  [[ "$(jq 'unique | length' <<< "$signers")" -eq "$count" ]] || fail "Signer addresses must be unique."
  while IFS= read -r addr; do
    [[ -z "$addr" ]] || xrpl tx new signer-list-set --account "$addr" --signer-quorum 1 --signer-entry "$addr:1" >/dev/null
  done < <(jq -r '.[]' <<< "$signers")
  signers=$(jq 'map({address:.})' <<< "$signers")
  key="$(read_state '.keyPrefix')-$role"
  addr=$(identity "$key")
  for ((index=1; index<=3-count; index++)); do
    local signer_key="$key-signer-$index" signer_address
    signer_address=$(identity "$signer_key")
    signers=$(jq --arg key "$signer_key" --arg addr "$signer_address" '. + [{address:$addr,key:$key}]' <<< "$signers")
  done
  save --arg role "$role" --arg key "$key" --arg addr "$addr" --argjson signers "$signers" \
    '.[$role] = {address:$addr,key:$key,quorum:2,signers:$signers}'
}

handover() {
  local role="$1" step entry
  step="$role-signer-list"
  if ! done_step "$step"; then
    local args=()
    while IFS= read -r entry; do args+=(--signer-entry "$entry:1"); done < <(read_state ".$role.signers[].address")
    xrpl tx new signer-list-set --account "$(address "$role")" --signer-quorum 2 "${args[@]}" > "$WORK/draft.json"
    send "$step" single "$role"
    complete "$step"
  fi
  step="$role-ready"
  if ! done_step "$step"; then
    xrpl tx new account-set --account "$(address "$role")" --set-flag asfDisableMaster > "$WORK/draft.json"
    send "$step" single "$role"
    complete "$step"
  fi
}
