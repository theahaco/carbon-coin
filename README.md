# Carbon Coin: a Rust CLI walkthrough

Create an XRPL multi-purpose token (MPT), give its issuer and governance accounts
separate 2-of-3 signer lists, mint 1,000 units, and transfer 250 to a holder.

The walkthrough is eight small Bash scripts in [scripts/](scripts/). Open each
script before running it: every transaction is a visible sequence of CLI commands.
You only need to recognize variables and pipes; no TypeScript or jq syntax is
needed to follow the examples.

## Get ready

Install Bash, Git, Rust/Cargo, a C compiler, jq, and Docker with Compose.
Linux source builds also need pkg-config and the OpenSSL development package.
Node and npm are only needed for the separate browser app and automated tests.

Run all commands from this repository's root directory:

~~~sh
bash scripts/setup-cli.sh
bash scripts/start.sh
~~~

The installer builds the exact revision in [cli.json](cli.json):
[xrpl-rust PR #44](https://github.com/theahaco/xrpl-rust/pull/44),
commit 7fd4b41631d0ff3aefb13f6cc35e8bc2960276c6. This upstream stack is still
unmerged. [cli/Cargo.lock](cli/Cargo.lock) keeps the source build reproducible;
an installable upstream release can eventually replace this bootstrap.

The Docker node listens on localhost ports 5005 (HTTP) and 6006 (WebSocket).
It closes ledgers when a script submits a transaction, so no background ledger
process is needed. Stop any older demo node occupying those ports first.

## Run the examples

~~~sh
bash scripts/01-wallets.sh      # Generate keys and register account names
bash scripts/02-fund.sh         # Fund issuer, governance, and holder with test XRP
bash scripts/03-issuer.sh       # Create the token and secure its issuer
bash scripts/04-governance.sh   # Authorize governance and secure its account
bash scripts/05-mint.sh         # Mint 1,000 units to governance
bash scripts/06-holder.sh       # Let the holder opt in to receiving this token
bash scripts/07-transfer.sh     # Transfer 250 units from governance to holder
bash scripts/08-status.sh       # Inspect the accounts, token, and balances
~~~

The final balances are **750 units in governance** and **250 in the holder**.
Issuer and governance each have their master key disabled and their own
independent set of three signers. Any two signers from the relevant set can act.

Edit the amount near the top of the mint or transfer script to experiment.
Edit [demo/token-metadata.json](demo/token-metadata.json) before creating the
token to change its identity. The short field names are the XLS-89 metadata
format: t = ticker, n = name, d = description, i = icon, ac/as = asset
class/subclass, and in = issuer name. Units are whole numbers; transfer, lock,
and clawback are enabled.

## Read a transaction

The wallet step creates a named key and records its account directly in the CLI:

~~~bash
xrpl key generate issuer --algorithm ed25519
xrpl account add issuer --key issuer --network-id 0
~~~

The CLI derives the account's address from its key. There is no separate address
map to maintain. Account names select who acts; key names select who signs.

The mint script is the main example:

~~~bash
AMOUNT=1000

xrpl tx new payment --account issuer \
  --destination "$(xrpl account show governance --address)" \
  --amount "$AMOUNT/$MPT_ID" --memo "CLI demo mint" |
  xrpl tx autofill --url "$URL" --signers 2 |
  xrpl tx sign --multisign --sign-with issuer_signer_1 |
  xrpl tx sign --multisign --sign-with issuer_signer_2 |
  xrpl tx submit --url "$URL" --wait --accept-ledger
~~~

- A variable such as $AMOUNT holds a value used by the command.
- $(xrpl account show governance --address) reads the address from the named
  CLI record and inserts it into the command. No JSON parsing is needed.
- A backslash continues a command on the next line.
- A pipe sends one command's JSON output to the next command.
- **new** creates a transaction. The amount is units/token-ID for an MPT.
- **autofill** fills in the account sequence, fee, and ledger expiry.
- **sign** adds a signature from a named key in the CLI store.
- **submit** sends it and waits for validation. The accept-ledger option closes
  a ledger on the standalone node.

The same four stages appear throughout the examples. The CLI accepts a name
directly for the account option. Destinations and signer entries still require
addresses, obtained with account show NAME --address from the same CLI store.
Signing uses an explicit named key, such as --sign-with issuer_signer_1.
The helpers in [scripts/lib/](scripts/lib/) handle the node check and token ID;
jq is still a setup dependency, but account lookups do not need it and there
are no jq expressions in the numbered scripts.

To try CLI commands directly in your terminal, load the same environment first:

~~~bash
source scripts/lib/environment.sh
xrpl key ls
xrpl account ls
xrpl account show issuer --address
xrpl account info --account issuer --signer-lists --url "$URL"
xrpl tx new payment --help
~~~

## Start over

Run the numbered setup steps once, in order. Minting or transferring again
performs another payment. These are disposable examples: they do not implement
annual mint limits, deployment migration, or automatic recovery after an
interrupted transaction.

Everything generated by the walkthrough is in the ignored .demo/ directory,
including the CLI's encrypted key store. The scripts use a public demo passphrase
and a public standalone genesis seed. Use them only with a disposable local node;
they are not Testnet or production deployment tooling.

To remove the local ledger and its demo keys and repeat from step 1:

~~~sh
bash scripts/stop.sh
rm -rf .demo
bash scripts/start.sh
~~~

The CLI build is retained, so it does not need to be rebuilt. DEMO_DIR and
XRPL_URL can select a different scratch directory and local HTTP port for tests.

## Browser app and development

The existing Astro/GhostSig app is separate from this local CLI walkthrough. Its
checked-in configuration continues to target its existing Testnet deployment;
these scripts do not publish local demo accounts into that configuration.
Its JavaScript SDK stays on the pin adopted by
[PR #10](https://github.com/theahaco/carbon-coin/pull/10).

~~~sh
npm run prototype:setup
npm ci
npm --prefix web ci
npm run web:dev
~~~

For contributors:

~~~sh
npm run cli:lint           # ShellCheck
npm run typecheck
npm run test:integration
npm run web:test
npm run web:build
~~~

The CLI integration test runs the actual numbered scripts and pinned Rust binary
against a fresh Docker ledger, checking named key/account records, the quorums,
disabled master keys, token metadata, mint, holder authorization, balances, and
read-only status. The existing SDK ledger regressions and browser tests remain
independent checks.
