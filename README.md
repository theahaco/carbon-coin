# Carbon Coin

A native XRPL MPToken with a multisig issuer and a separate multisig governance
account. The operational commands use the **Rust `xrpl` CLI**. The static Astro
frontend continues to use the Aha JavaScript SDK and GhostSig.

## Dependencies and setup

- Node.js 22.12+ for the frontend, tests, and loading `.env` as data.
- Rust/Cargo, a C compiler, Git, Bash, jq, and curl for the CLI workflows.
  Linux source builds also need the OpenSSL development package and pkg-config.
- Docker with Compose for the disposable local network; unnecessary for Testnet.

```sh
npm run cli:setup         # builds the exact Rust commit in cli.json
npm run prototype:setup   # builds the browser/test SDK pinned in prototype.json
npm ci
npm --prefix web ci
cp .env.example .env
```

The CLI pin is [xrpl-rust PR #42](https://github.com/theahaco/xrpl-rust/pull/42),
commit `1b769886f676e3fad174b19c156432e0f1662fe1`. That stack is still unmerged.
Upstream does not commit Cargo.lock, so `cli/Cargo.lock` locks this app's CLI
build. The installer fetches that commit and builds with `--locked`. `XRPL_BIN`
can point to an equivalent local build. No globally installed CLI is assumed.

The browser/test SDK remains on the stack adopted by [PR #10](https://github.com/theahaco/carbon-coin/pull/10).
Both pins are independent. The browser still needs the SDK even though the
operational commands no longer import it.

Edit `.env` to set the `TOKEN_*` identity fields and `XRPL_NETWORK`. The Node
launcher parses dotenv syntax without executing it as shell code; transaction
construction, autofill, signing, submission, and ledger reads all run through
`xrpl`.

## Networks

- `XRPL_NETWORK=local` uses `http://localhost:5005`. A fresh standalone node is
  funded from its published genesis account. `tx submit --wait --accept-ledger`
  closes ledgers on demand; no background TypeScript ledger process is needed.
- `XRPL_NETWORK=testnet` uses `https://s.altnet.rippletest.net:51234`. Keys are
  enrolled **before** the public faucet is asked to fund their addresses. The
  workflow polls for validated funding and never uses genesis funding on Testnet.

`XRPL_URL` overrides the HTTP JSON-RPC endpoint; the old `XRPL_WS_URL` setting
applies only to SDK test fixtures. `XRPL_FAUCET_URL` overrides the Testnet faucet.
The CLI checks the node's network ID; local mode additionally requires zero
peers and a zero validation quorum. State from another network is rejected.
Use a separate `TOKEN_STATE_FILE` for each deployment/network.

```sh
npm run devnet:up         # Docker Compose, HTTP 5005 and WS 6006 on loopback
npm run devnet:down       # stops only this Compose project
```

The node is disposable: `down` removes it and its ledger. Use fresh deployment
state and key IDs after a reset. A node started by the old TypeScript tooling
must be stopped with that version's `devnet:down` before starting Compose.

## Keys and existing deployments

Keys live in the CLI's **passphrase-encrypted store**, selected by `XRPL_DATA_DIR`
or its platform default. `XRPL_CONFIG_DIR` selects CLI preferences. Use private
absolute paths; the application does not put a key store in the repository.
Back up the store and passphrase together. `.deployment.json` contains only key
IDs, addresses, token state, and transaction checkpoints; it cannot restore keys.

For unattended use, supply `XRPL_PASSPHRASE` through the environment or a secret
manager. Otherwise the CLI prompts on the controlling terminal. There is no
built-in/default passphrase. Secrets are encrypted at rest and present in process
memory when signing.

To retain an existing deployment made by the TypeScript scripts:

```sh
npm run deployment:import
```

This imports the existing master and local signer seeds into the encrypted store,
checks every derived address, preserves external signers and minted periods, then
atomically replaces the legacy state with version 2. It does not transact or
change the on-ledger signer lists. Until all imports succeed, the original seeds
remain in the state file so the command can resume. No additional plaintext backup
is created. Previously made backups still contain seeds and need the same care.
Other operational commands refuse legacy state until this explicit import runs.

## Token workflow

```sh
npm run setup:issuer
npm run setup:governance
npm run mint -- 100000 2026
npm run redistribute -- <authorized-recipient-address> 25000
npm run status
npm run web:sync-config
```

- Issuance omits `AssetScale` and `MaximumAmount`: whole raw units and the ledger's
  default cap. Transfer, lock, and clawback flags remain enabled; allowlisting is
  not enabled. The configured identity is encoded as XLS-89 compact JSON.
- Issuer and governance each have a separate, equal-weight **2-of-3** signer list.
  `ISSUER_SIGNER_ADDRESSES` and `GOVERNANCE_SIGNER_ADDRESSES` accept up to three
  external addresses each. Remaining slots get independently generated keys;
  signer accounts need not be funded merely to sign for these accounts.
- Issuance/holder authorization happen under the bootstrap master key, followed
  by the signer list and then master-key disable. Each validated step is saved
  before continuing. Rerunning setup resumes rather than replacing accounts.
- Local minting and redistribution need two available local keys. Otherwise the
  command points to the GhostSig ceremony; it never invents keys for external
  addresses. Local signatures use bounded ledger expiry.
- Mint memos retain `MemoType=mint-period` and the supplied period as `MemoData`,
  so the browser's history remains compatible. A recorded period is refused
  unless `--force` is supplied. This is local bookkeeping, not a ledger-enforced
  annual supply rule.
- Recipients must self-authorize with `MPTokenAuthorize` before receiving MPTs.
  The sender cannot sign that authorization for them. The CLI warns on missing
  authorization and reports a failed ledger result as failure.

`status` only reads the ledger and local state. It never bootstraps, mints, or
redistributes. It prints the issuance, account flags/signer lists, exact governance
holding, and local mint-period record.

## Interrupted operations

A deployment lock prevents two commands from mutating the same state concurrently.
Before submitting, the wrapper atomically saves the signed transaction in
`.pending`. If a response is lost, rerun the **same command and arguments**: it
checks the transaction hash and, if needed, resubmits the same signed transaction.
An already applied payment cannot mint again.
A different operation is refused while one is unresolved.

A validated failure is recorded as `lastFailedTransaction` and clears pending;
it does not record a successful mint. Transport errors, preliminary rejections,
and expiry uncertainty retain pending. If the original transaction cannot finish,
inspect its hash with `xrpl tx hash` and the ledger's `tx` result before resolving
that checkpoint manually; do not delete it just to retry with a fresh sequence.
After SIGKILL, remove the `.deployment.json.lock` directory only after confirming
no command is still using that state.

## Frontend

The frontend remains a static Astro site using GhostSig for passkey signing and
multi-person ceremonies. It targets Testnet regardless of the CLI's local setting.
At least one real GhostSig address must be in the relevant on-ledger signer list
for that person to participate.

```sh
npm run web:sync-config   # explicit allowlist: token identity, addresses, quorum
npm run web:dev
npm run web:build
npm run web:test
```

The exported `web/public/deployment.json` keeps the existing browser schema. It
contains no seeds, key IDs, signatures, or pending transactions. `TOKEN_PUBLIC_CONFIG`
can select a different output path. This command publishes a local file only.

## Validation

```sh
npm run cli:lint         # requires shellcheck
npm run typecheck
npm run test:integration
npm run web:test
npm run web:build
```

The CLI suite drives the actual shell commands and pinned Rust binary against
fresh Docker ledgers. It checks token policy, independent quorums, disabled master
keys, typed memos, duplicate/forced mints, redistribution, read-only status,
secret-free export, legacy import, and recovery after a lost submission response.
A local faucet/proxy fixture exercises the Testnet code path, including retries,
without relying on the public faucet. Public-network availability and a real
GhostSig passkey ceremony are outside this automated gate.

The pre-existing SDK ledger regressions remain as an independent check, including
freeze/unfreeze and clawback. Their TypeScript helpers live under `test/helpers/`;
no production command imports them. CI builds both pins and runs the suites.
