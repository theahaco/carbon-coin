import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Client, decodeMPTokenMetadata, fetchMPTokenOrUndefined } from 'xrpl'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import path from 'node:path'
import { accountRecords, cliEnvironment, demo } from '../helpers/cli.js'
import { startRippledNode } from '../helpers/rippledNode.js'

describe('numbered Bash walkthrough through the pinned Rust CLI', () => {
  let node: Awaited<ReturnType<typeof startRippledNode>>
  let client: Client
  let env: NodeJS.ProcessEnv
  let directory: string
  let accounts: Record<string, string>
  let issuanceId: string

  beforeAll(async () => {
    // No SDK ledger-advance loop: the scripts must close their own ledgers.
    node = await startRippledNode()
    client = new Client(node.wsUrl)
    await client.connect()
    const context = cliEnvironment({ XRPL_URL: node.rpcUrl })
    env = context.env
    directory = context.directory
  })
  afterAll(async () => {
    await client?.disconnect()
    await node?.container.stop()
    if (directory) rmSync(directory, { recursive: true, force: true })
  })

  it('creates the token and independent quorums, then disables both master keys', async () => {
    for (const script of ['01-wallets.sh', '02-fund.sh', '03-issuer.sh', '04-governance.sh']) {
      await demo(env, script)
    }
    const records = await accountRecords(env)
    expect(records).toHaveLength(10) // Nine generated identities and standalone genesis.
    for (const record of records) {
      expect(record.keys).toEqual([record.alias])
      expect(record.network_id).toBe(0)
    }
    accounts = Object.fromEntries(records.map((record) => [record.alias.toUpperCase(), record.address]))
    expect(accounts.GENESIS).toBe('rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh')
    expect(existsSync(path.join(directory, 'accounts.env'))).toBe(false)
    issuanceId = readFileSync(path.join(directory, 'issuance-id'), 'utf8').trim()
    const { result } = await client.command.ledgerEntry({
      mpt_issuance: issuanceId, ledger_index: 'validated',
    })
    expect(result.node.AssetScale ?? 0).toBe(0)
    expect(result.node.MaximumAmount).toBeUndefined()
    expect(result.node.Flags).toBe(98)
    expect(decodeMPTokenMetadata(result.node.MPTokenMetadata!)).toMatchObject({
      ticker: 'DEMO', name: 'CLI Demo Token', issuer_name: 'CLI Demo',
    })
    const signerAddresses = []
    for (const role of ['ISSUER', 'GOVERNANCE']) {
      const info = await client.command.accountInfo({
        account: accounts[role]!, signer_lists: true, ledger_index: 'validated',
      })
      expect(info.result.account_flags?.disableMasterKey).toBe(true)
      const list = info.result.signer_lists?.[0]
      expect(list?.SignerQuorum).toBe(2)
      expect(list?.SignerEntries.map(({ SignerEntry }) => SignerEntry.Account).sort())
        .toEqual([1, 2, 3].map((index) => accounts[role + '_SIGNER_' + index]).sort())
      expect(list?.SignerEntries.every(({ SignerEntry }) => SignerEntry.SignerWeight === 1)).toBe(true)
      signerAddresses.push(...list!.SignerEntries.map(({ SignerEntry }) => SignerEntry.Account))
    }
    expect(new Set(signerAddresses).size).toBe(6)
    await expect(demo(env, '01-wallets.sh')).rejects.toThrow(/Demo keys already exist/)
    expect(await accountRecords(env)).toEqual(records)
  }, 240_000)

  it('mints 1,000 units with two issuer signatures', async () => {
    const result = await demo(env, '05-mint.sh')
    expect(JSON.parse(result.stdout).meta.TransactionResult).toBe('tesSUCCESS')
    const holding = await fetchMPTokenOrUndefined(client, accounts.GOVERNANCE!, issuanceId, 'validated')
    expect(holding?.MPTAmount).toBe('1000')
  }, 120_000)

  it('requires holder authorization, then transfers 250 units with the governance quorum', async () => {
    await expect(demo(env, '07-transfer.sh')).rejects.toThrow(/tecNO_AUTH/)
    await demo(env, '06-holder.sh')
    await demo(env, '07-transfer.sh')
    expect((await fetchMPTokenOrUndefined(client, accounts.HOLDER!, issuanceId, 'validated'))?.MPTAmount).toBe('250')
    expect((await fetchMPTokenOrUndefined(client, accounts.GOVERNANCE!, issuanceId, 'validated'))?.MPTAmount).toBe('750')
  }, 120_000)

  it('shows the final ledger state without submitting transactions', async () => {
    const before = await client.command.accountInfo({ account: accounts.GOVERNANCE! })
    const status = await demo(env, '08-status.sh')
    expect(status.stdout).toContain(issuanceId)
    expect(status.stdout).toMatch(/"MPTAmount":\s*"750"/)
    expect(status.stdout).toMatch(/"MPTAmount":\s*"250"/)
    const after = await client.command.accountInfo({ account: accounts.GOVERNANCE! })
    expect(after.result.account_data.Sequence).toBe(before.result.account_data.Sequence)
  })
})
