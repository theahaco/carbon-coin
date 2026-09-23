# From app plumbing to SDK workflows

Carbon Coin now consumes `xrpl@5.3.0-aha.devx.1` at
[`d3fb578b`](https://github.com/theahaco/xrpl.js/commit/d3fb578b1e4a500d75bda1f7eea21ddacd366195).
Both Node and browser builds use this exact source pin. This follows
[the initial migration, PR #9](https://github.com/theahaco/carbon-coin/pull/9).

The follow-up removes **258 lines across eight helper modules: 538 → 280
(48%)**, including comments and formatting. This is a reproducible comparison
against PR #9's `ec8d0f6` head, not a claim about the entire application's size.
The remaining code expresses Carbon Coin policy: equal-weight quorum, local
signer selection, the `mint-period` memo, GhostSig handoff and Gton display units.

## Review the stack

[Epic #58](https://github.com/theahaco/xrpl.js/issues/58) tracks four SDK PRs:

1. [#59 — outcomes and optional MPT reads](https://github.com/theahaco/xrpl.js/pull/59), based on prototype #57.
2. [#60 — account-bound builders and shared wallet scopes](https://github.com/theahaco/xrpl.js/pull/60), based on #59.
3. [#61 — immutable multisig preparation and co-signing](https://github.com/theahaco/xrpl.js/pull/61), based on #60.
4. [#62 — MPT eligibility, history and memo helpers](https://github.com/theahaco/xrpl.js/pull/62), based on #61.

All work is on the Aha forks. The downstream PR stacks on Carbon Coin #9.
Review or merge in dependency order; no npm release is required for this example.

## Journey 1: mint tokens

Before, the application built the transaction and implemented preparation and
multisigning in its own helper:

```ts
const paymentTx = buildMptPaymentTx(
  issuer.address, governance.address, mptIssuanceId, amount,
  { type: 'mint-period', data: period },
)
const result = await submitMultisigned(client, paymentTx, selectedSigners)

// Hidden inside the application helper:
const prepared = await client.autofill(tx, signers.length)
prepared.SigningPubKey = ''
const blob = multisign(signers.map(({ seed }) =>
  Wallet.fromSeed(seed).sign(prepared, true).tx_blob))
return client.submitAndWait(blob)
```

After, [the mint script](../src/scripts/mint.ts) states the transaction intent:

```ts
const result = await client.forAccount(issuer.address).tx.payment({
  Destination: governance.address,
  Amount: { mpt_issuance_id: mptIssuanceId, value: amount },
  Memos: [encodeMemo({ type: 'mint-period', data: period })],
}).multisignAndSubmit(localSigners(issuer.signers, issuer.quorum))
console.log(`Mint succeeded (tx hash: ${result.result.hash}).`)
```

The `.tx` completion list teaches the available transactions. Payment supplies
its discriminator and default account, infers its fields and returns only after
validated success. The app no longer implements signature assembly or compares
success strings. SDK tests verify payload identity, real signatures, duplicate
signers, fee counts and immutable snapshots. Ledger tests still prove that an
insufficient quorum and disabled master key fail.

## Journey 2: prepare a GhostSig ceremony

Before, the app independently fetched sequence and calculated a fee:

```ts
const tx = buildMptPaymentTx(from, to, issuance, value, memo)
tx.SigningPubKey = ''
const [fee, sequence] = await Promise.all([
  computeMultisigFeeDrops(quorum), getAccountSequence(from),
])
tx.Fee = fee
tx.Sequence = sequence
return { ...tx }
```

After, [proposal preparation](../web/src/lib/tx.ts) uses the SDK lifecycle:

```ts
const proposal = await client.forAccount(fromAddress).tx.payment({
  Destination: toAddress,
  Amount: { mpt_issuance_id: mptIssuanceId, value: valueRaw },
  ...(memo ? { Memos: [encodeMemo(memo)] } : {}),
}).prepareMultisig({ signersCount, expiry: 'none' })
return { ...proposal.toJSON() }
```

`signersCount` means actual signatures, not weighted quorum. They coincide for
this app's equal-weight policy. GhostSig still owns the keys, co-signing flow and
submission. The external payload has one fixed fee/sequence before any signature.
Unbounded expiry is now an explicit app policy; the proposal remains usable until
its sequence is consumed. Normal local multisigning keeps bounded expiry.

Local bootstrap signing uses `client.withWallet(wallet).tx` on the existing
connection. The old connection-opening wrapper is gone.

## Journey 3: inspect holdings and mint history

Before, the app caught and inspected ledger errors itself and fetched one
`account_tx` page with a limit of 200. Any Payment carrying a `mint-period` memo
could appear in history, including an incoming payment, failed transaction or
payment of a different asset.

After:

```ts
const holding = await fetchMPTokenOrUndefined(
  client, address, mptIssuanceId, 'validated',
)
const { payments } = await client.getMptPaymentHistory(issuerAddress, mptIssuanceId)
```

Only an explicit missing entry becomes `undefined`; network/RPC failures remain
errors. History follows all pages in the server's available ledger range and
includes only validated successful outgoing payments of the selected MPT.
The app decodes its business memo and displays the delivered amount. It skips
binary memos and records whose delivered amount is unknown. History read failures
are displayed, and public period text is inserted as text rather than HTML.

The SDK reports the searched ledger range: available history is not necessarily
full network history. A partial payment's requested amount is never substituted
for an unknown delivered amount. The app's period suggestion is advisory, not an
on-ledger uniqueness constraint.

## Journey 4: check before collecting signatures

The previous recipient warning looked only for an existing, unlocked holding.
It now uses `client.getMptTransferReadiness` with the source and destination.
The SDK checks MPT eligibility at one validated ledger snapshot, including
self-authorization, issuer authorization, global/holder locks and transfer policy.
It can also check raw balances and supply when an amount is supplied; this is
exercised by the real-ledger mint test.

The result is advisory. Domain credentials and transfer fees can be unknown;
fees/reserves, signer authority, sequence/expiry, destination settings and complex
payment options are explicitly unassessed. Browser read failures display an
unavailable-check message instead of silently hiding the warning. Only validated
submission establishes success.

## What disappeared

| Helper module | Before | After | Change |
| --- | ---: | ---: | --- |
| `src/lib/client.ts` | 30 | 15 | Removed extra signing connections |
| `src/lib/ledger.ts` | 22 | 0 | Deleted optional-read/error wrapper |
| `src/lib/mpt.ts` | 115 | 6 | Deleted four transaction factories and memo codec; retained issuance policy |
| `src/lib/multisig.ts` | 56 | 30 | Deleted prepare/combine/submit wrappers; retained quorum/key selection |
| `web/src/lib/tx.ts` | 38 | 28 | Replaced fee/sequence assembly with prepared multisig |
| `web/src/lib/xrplClient.ts` | 167 | 113 | Removed fee/sequence helpers and manual history filtering/decoding |
| `web/src/lib/gton.ts` | 34 | 12 | SDK exact unit conversion; same 1 Gton = 10⁹ raw-unit convention |
| `web/src/lib/preview.ts` | 76 | 76 | Shared memo decoding and malformed-text handling |
| **Total** | **538** | **280** | **258 fewer lines** |

Gton remains an application display convention. The issuance's AssetScale and
ledger amounts are unchanged.

## Verification and remaining boundaries

- SDK: all seven packages and browser bundles build; strict lint for changed
  TypeScript; 147 unit suites / 1,452 tests pass.
- Downstream: TypeScript and Astro checks; production browser build; 11 browser
  unit tests, including GhostSig handoff and prepared fee/sequence/expiry behavior.
- Standalone ledger: minting, advisory eligibility, successful history lookup,
  quorum/master-key failure, absent authorization, governance transfers, lock/
  unlock and clawback. The two former message-string assertions now inspect the
  structured error's preliminary code and expiry phase instead.
- No public-network transaction or real passkey ceremony was performed. The
  browser handoff is covered through its existing mocked GhostSig boundary.

The existing application findings around comprehensive signing-preview validation
and recoverable bootstrap/state persistence remain separate work. This stack does
not claim to resolve them. Review the older [migration PR](https://github.com/theahaco/carbon-coin/pull/9)
for that context.
