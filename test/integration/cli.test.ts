import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Client, Wallet, decodeMPTokenMetadata, fetchMPTokenOrUndefined, decodeMemo } from 'xrpl'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { cliEnvironment, deployment, token } from '../helpers/cli.js'
import { startLocalNetwork, type LocalNetworkHandle } from '../helpers/localNetwork.js'
import { setupAuthorizedHolder } from '../helpers/fixtures.js'
import { fundNewWallet } from '../helpers/sdk/fund.js'

describe('operational commands through the pinned Rust CLI', () => {
  let network: LocalNetworkHandle
  let client: Client
  let env: NodeJS.ProcessEnv
  let directory: string
  let recipient: Wallet
  const externalIssuer = Wallet.generate().address
  const externalGovernance = Wallet.generate().address

  beforeAll(async () => {
    network = await startLocalNetwork()
    client = new Client(network.wsUrl)
    await client.connect()
    const context = cliEnvironment({
      XRPL_URL: network.rpcUrl,
      ISSUER_SIGNER_ADDRESSES: externalIssuer,
      GOVERNANCE_SIGNER_ADDRESSES: externalGovernance,
    })
    env = context.env
    directory = context.directory
  })
  afterAll(async () => {
    await client?.disconnect()
    await network?.teardown()
    if (directory) rmSync(directory, { recursive: true, force: true })
  })

  it('bootstraps independent quorums, resumes setup, and preserves token policy', async () => {
    await token(env, 'setup:issuer')
    await token(env, 'setup:governance')
    const state = deployment(env)
    expect(state.version).toBe(2)
    expect(JSON.stringify(state)).not.toContain('"seed"')
    expect(state.issuer.signers).toHaveLength(3)
    expect(state.governance.signers).toHaveLength(3)
    expect(state.issuer.signers[0]).toEqual({ address: externalIssuer })
    expect(state.governance.signers[0]).toEqual({ address: externalGovernance })
    expect(state.issuer.signers.map((s: { address: string }) => s.address))
      .not.toEqual(state.governance.signers.map((s: { address: string }) => s.address))
    const issuanceId: string = state.mptIssuanceId
    const { result } = await client.command.ledgerEntry({ mpt_issuance: issuanceId, ledger_index: 'validated' })
    expect(result.node.AssetScale ?? 0).toBe(0)
    expect(result.node.MaximumAmount).toBeUndefined()
    expect(result.node.Flags & 98).toBe(98)
    expect(decodeMPTokenMetadata(result.node.MPTokenMetadata!)).toMatchObject({
      ticker: 'TEST', name: 'Test Token', issuer_name: 'Test Issuer',
    })
    for (const role of ['issuer', 'governance']) {
      const info = await client.command.accountInfo({ account: state[role].address, signer_lists: true })
      expect(info.result.account_flags?.disableMasterKey).toBe(true)
      expect(info.result.signer_lists?.[0]?.SignerQuorum).toBe(2)
    }
    const before = readFileSync(env.TOKEN_STATE_FILE!, 'utf8')
    await token(env, 'setup:issuer')
    await token(env, 'setup:governance')
    expect(readFileSync(env.TOKEN_STATE_FILE!, 'utf8')).toBe(before)
  }, 240_000)

  it('mints with browser-compatible period memos and guards duplicate periods', async () => {
    await token(env, 'mint', '1000', '2026')
    const state = deployment(env)
    const tx = await client.command.tx({ transaction: state.lastMintHash as string, binary: false })
    const memos = tx.result.tx_json.Memos
    expect(memos?.map((m) => decodeMemo(m))).toContainEqual({ type: 'mint-period', data: '2026' })
    await expect(token(env, 'mint', '1000', '2026')).rejects.toThrow(/already minted/)
    await token(env, 'mint', '1', '2026', '--force')
    expect(deployment(env).mintedPeriods).toEqual(['2026'])
    const holding = await fetchMPTokenOrUndefined(client, state.governance.address, state.mptIssuanceId, 'validated')
    expect(holding?.MPTAmount).toBe('1001')
  }, 180_000)

  it('redistributes to an authorized holder and status performs no transactions', async () => {
    const state = deployment(env)
    recipient = await setupAuthorizedHolder(client, { name: 'local', wsUrl: network.wsUrl }, state.mptIssuanceId)
    await token(env, 'redistribute', recipient.address, '250')
    expect((await fetchMPTokenOrUndefined(client, recipient.address, state.mptIssuanceId, 'validated'))?.MPTAmount).toBe('250')
    const before = readFileSync(env.TOKEN_STATE_FILE!, 'utf8')
    const result = await token(env, 'status')
    expect(result.stdout).toContain('751')
    expect(readFileSync(env.TOKEN_STATE_FILE!, 'utf8')).toBe(before)
    await token(env, 'web:sync-config')
    const publicConfig = JSON.parse(readFileSync(env.TOKEN_PUBLIC_CONFIG!, 'utf8'))
    expect(publicConfig.issuer.signers).toEqual(state.issuer.signers.map(({ address }: { address: string }) => ({ address })))
    expect(JSON.stringify(publicConfig)).not.toMatch(/"key"|"seed"/)
  }, 120_000)

  it('rejects fractional/out-of-range amounts and an external-only quorum', async () => {
    await expect(token(env, 'mint', '1.1', '2027')).rejects.toThrow(/whole non-negative/)
    await expect(token(env, 'mint', '9223372036854775808', '2027')).rejects.toThrow(/maximum/)
    const state = deployment(env)
    const changed = structuredClone(state)
    changed.issuer.signers.forEach((signer: { key?: string }) => delete signer.key)
    writeFileSync(env.TOKEN_STATE_FILE!, JSON.stringify(changed))
    await expect(token(env, 'mint', '1', '2027')).rejects.toThrow(/GhostSig/)
    writeFileSync(env.TOKEN_STATE_FILE!, JSON.stringify(state))
  })

  it('resumes an uncertain submission with the same signed transaction, without double minting', async () => {
    const wrapper = path.join(directory, 'interrupted-cli')
    writeFileSync(wrapper, [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'if [[ "$1" == tx && "$2" == submit ]]; then',
      '  "$REAL_XRPL_BIN" "$@" >/dev/null',
      '  echo "simulated lost submission response" >&2',
      '  exit 2',
      'fi',
      'exec "$REAL_XRPL_BIN" "$@"',
      '',
    ].join('\n'), { mode: 0o700 })
    await expect(token({ ...env, REAL_XRPL_BIN: env.XRPL_BIN, XRPL_BIN: wrapper }, 'mint', '7', '2027'))
      .rejects.toThrow(/lost submission response/)
    const pending = deployment(env).pending
    expect(pending.transaction.Signers).toHaveLength(2)
    expect(deployment(env).mintedPeriods).not.toContain('2027')
    await expect(token(env, 'redistribute', recipient.address, '1')).rejects.toThrow(/Unresolved operation/)
    await token(env, 'mint', '7', '2027')
    const state = deployment(env)
    expect(state.pending).toBeUndefined()
    expect(state.mintedPeriods).toContain('2027')
    expect((await fetchMPTokenOrUndefined(client, state.governance.address, state.mptIssuanceId, 'validated'))?.MPTAmount).toBe('758')
  }, 120_000)

  it('reports a validated authorization failure without retaining an uncertain operation', async () => {
    const holder = await fundNewWallet(client, { name: 'local', wsUrl: network.wsUrl })
    await expect(token(env, 'redistribute', holder.address, '1')).rejects.toThrow(/tecNO_AUTH/)
    const state = deployment(env)
    expect(state.pending).toBeUndefined()
    expect(state.lastFailedTransaction.meta.TransactionResult).toBe('tecNO_AUTH')
  }, 120_000)
})
