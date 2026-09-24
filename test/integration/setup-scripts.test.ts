import { execFile } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Client, MPTokenFlags, fetchMPTokenIssuance, fetchMPTokenOrUndefined } from 'xrpl'
import {
  GOVERNANCE_ADMISSION_MEMO,
  ensureAdmittedWithMasterKey,
  ensureMasterKeyDisabled,
  ensureSelfAuthorized,
  isHolderAdmitted,
  isMasterKeyDisabled,
  masterWallet,
} from '../../src/lib/bootstrap.js'
import type { AccountState, DeploymentState } from '../../src/lib/config.js'
import { fundNewWallet, fundSignerWallets } from '../../src/lib/fund.js'
import { resolveNetwork, type NetworkConfig } from '../../src/lib/network.js'
import { startLocalNetwork, type LocalNetworkHandle } from '../helpers/localNetwork.js'
import { SIGNER_COUNT, SIGNER_QUORUM, requireAuthEnv, setupGovernance, setupIssuer, testEnv } from '../helpers/fixtures.js'

const run = promisify(execFile)
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const tsx = path.join(repoRoot, 'node_modules', '.bin', 'tsx')

/**
 * Runs one of the npm scripts' entry points as its own process, in `cwd`
 * (where it reads and writes .deployment.json; there's no .env there).
 * execFile is asynchronous, so this process keeps advancing the ledger.
 */
async function runScript(name: string, cwd: string, env: NodeJS.ProcessEnv): Promise<string> {
  const { stdout } = await run(tsx, [path.join(repoRoot, 'src/scripts', `${name}.ts`)], { cwd, env })
  return stdout
}

/** Like `runScript`, for a run that must exit with an error. Returns its stdout and stderr. */
async function runScriptExpectingFailure(name: string, cwd: string, env: NodeJS.ProcessEnv): Promise<string> {
  try {
    await runScript(name, cwd, env)
  } catch (error) {
    const { stdout = '', stderr = '' } = error as { stdout?: string; stderr?: string }
    return `${stdout}${stderr}`
  }
  throw new Error(`${name} was expected to fail, but it succeeded.`)
}

function readState(cwd: string): DeploymentState {
  return JSON.parse(readFileSync(path.join(cwd, '.deployment.json'), 'utf-8')) as DeploymentState
}

function writeState(cwd: string, state: DeploymentState): void {
  writeFileSync(path.join(cwd, '.deployment.json'), JSON.stringify(state, null, 2) + '\n')
}

async function sequenceOf(client: Client, address: string): Promise<number> {
  const info = await client.command.accountInfo({ account: address, ledger_index: 'validated' })
  return info.result.account_data.Sequence
}

describe('setup scripts', () => {
  let network: LocalNetworkHandle
  let netCfg: NetworkConfig
  let client: Client
  const dirs: string[] = []

  /**
   * What setup:governance saves right after funding: a governance account
   * with `masterKeyDisablePending`, before any of its bootstrap steps.
   */
  async function fundedGovernance(): Promise<AccountState> {
    const wallet = await fundNewWallet(client, netCfg)
    const signers = await fundSignerWallets(client, netCfg, SIGNER_COUNT)
    return { address: wallet.address, seed: wallet.seed!, signers, quorum: SIGNER_QUORUM, masterKeyDisablePending: true }
  }

  function workDir(): string {
    const dir = mkdtempSync(path.join(tmpdir(), 'carbon-coin-setup-'))
    dirs.push(dir)
    return dir
  }

  beforeAll(async () => {
    network = await startLocalNetwork()
    netCfg = resolveNetwork(testEnv(network.wsUrl))
    client = new Client(network.wsUrl)
    await client.connect()
  })

  afterAll(async () => {
    await client?.disconnect()
    await network?.teardown()
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
  })

  it('with RequireAuth, keeps the issuer master key until setup:governance admits governance', async () => {
    const cwd = workDir()
    const env = requireAuthEnv(network.wsUrl)

    await runScript('setup-issuer', cwd, env)
    const afterIssuer = readState(cwd)
    expect(afterIssuer.issuance).toEqual({ flags: 102, assetScale: 3 })
    expect(afterIssuer.issuer?.masterKeyDisablePending).toBe(true)
    expect(await isMasterKeyDisabled(client, afterIssuer.issuer!.address)).toBe(false)

    // A rerun changes nothing and says what's left to do.
    const rerun = await runScript('setup-issuer', cwd, env)
    expect(rerun).toMatch(/already set up/)
    expect(rerun).toMatch(/setup:governance/)
    expect(readState(cwd)).toEqual(afterIssuer)

    await runScript('setup-governance', cwd, env)
    const done = readState(cwd)
    expect(done.issuer?.masterKeyDisablePending).toBeUndefined()
    expect(done.governance?.masterKeyDisablePending).toBeUndefined()
    expect(await isMasterKeyDisabled(client, done.issuer!.address)).toBe(true)
    expect(await isMasterKeyDisabled(client, done.governance!.address)).toBe(true)
    const holding = await fetchMPTokenOrUndefined(client, done.governance!.address, done.mptIssuanceId!, 'validated')
    expect((holding?.Flags ?? 0) & MPTokenFlags.lsfMPTAuthorized).not.toBe(0)

    expect(await runScript('setup-governance', cwd, env)).toMatch(/Governance already set up/)

    const status = await runScript('status', cwd, env)
    expect(status).toMatch(/RequireAuth: yes/)
    expect(status).toMatch(/AssetScale: 3/)
    expect(status).toMatch(/Admitted by the issuer: yes/)
    expect(status).toMatch(/Both master keys disabled: yes/)
  }, 180_000)

  it('resumes an interrupted issuer setup without creating a second issuance', async () => {
    const cwd = workDir()
    const env = requireAuthEnv(network.wsUrl)

    await runScript('setup-issuer', cwd, env)
    const complete = readState(cwd)

    // As if the run had stopped right after MPTokenIssuanceCreate, before
    // anything about the issuance was saved.
    const { mptIssuanceId: _id, issuance: _issuance, ...interrupted } = complete
    writeFileSync(path.join(cwd, '.deployment.json'), JSON.stringify(interrupted, null, 2))

    const resumed = await runScript('setup-issuer', cwd, env)
    expect(resumed).toMatch(/Found the existing MPT issuance/)
    expect(readState(cwd)).toEqual(complete)
  }, 180_000)

  it('resumes a setup:governance run that stopped after the admission, and disables both master keys', async () => {
    const cwd = workDir()
    const env = requireAuthEnv(network.wsUrl)

    await runScript('setup-issuer', cwd, env)
    const afterIssuer = readState(cwd)
    const mptIssuanceId = afterIssuer.mptIssuanceId!

    // As if setup:governance had stopped right after the issuer's admission:
    // both pending flags are still set, and both master keys still enabled.
    const governance = await fundedGovernance()
    writeState(cwd, { ...afterIssuer, governance })
    await ensureSelfAuthorized(client, client.withWallet(masterWallet(governance)), mptIssuanceId)
    await ensureAdmittedWithMasterKey(
      client,
      client.withWallet(masterWallet(afterIssuer.issuer!)),
      mptIssuanceId,
      governance.address,
      GOVERNANCE_ADMISSION_MEMO,
    )

    const resumed = await runScript('setup-governance', cwd, env)
    expect(resumed).toMatch(/resuming/)
    expect(resumed).not.toMatch(/authorized to hold the MPT/)
    expect(resumed).not.toMatch(/admitted the governance account/)
    expect(resumed).toMatch(/Disabled the issuer's master key/)
    expect(resumed).toMatch(/Configured the governance account's 2-of-3 multisig/)
    expect(resumed).toMatch(/Disabled the governance account's master key/)

    const done = readState(cwd)
    expect(done.issuer?.masterKeyDisablePending).toBeUndefined()
    expect(done.governance?.masterKeyDisablePending).toBeUndefined()
    expect(await isMasterKeyDisabled(client, afterIssuer.issuer!.address)).toBe(true)
    expect(await isMasterKeyDisabled(client, governance.address)).toBe(true)
    expect(await isHolderAdmitted(client, governance.address, mptIssuanceId)).toBe(true)
  }, 180_000)

  it('stops when the issuer master key is already disabled but governance is not admitted', async () => {
    const cwd = workDir()
    const env = requireAuthEnv(network.wsUrl)

    await runScript('setup-issuer', cwd, env)
    const afterIssuer = readState(cwd)
    const mptIssuanceId = afterIssuer.mptIssuanceId!
    const governance = await fundedGovernance()
    writeState(cwd, { ...afterIssuer, governance })
    await ensureSelfAuthorized(client, client.withWallet(masterWallet(governance)), mptIssuanceId)
    await ensureMasterKeyDisabled(client, client.withWallet(masterWallet(afterIssuer.issuer!)))

    const output = await runScriptExpectingFailure('setup-governance', cwd, env)
    expect(output).toMatch(/isn't admitted yet, and the issuer's master key is already disabled/)
    expect(output).not.toMatch(/authorized to hold the MPT/)
    expect(readState(cwd).governance?.masterKeyDisablePending).toBe(true)
    expect(await isHolderAdmitted(client, governance.address, mptIssuanceId)).toBe(false)
    expect(await isMasterKeyDisabled(client, governance.address)).toBe(false)
  }, 180_000)

  it('refuses to pair a new issuance with a governance account set up for an earlier one', async () => {
    // A finished RequireAuth deployment: its governance account is admitted
    // for the first issuance and its master key is disabled.
    const env = requireAuthEnv(network.wsUrl)
    const first = await setupIssuer(client, netCfg, env)
    const oldGovernance = await setupGovernance(client, netCfg, first.mptIssuanceId, first.issuer)

    // setup:issuer won't start a new issuance while that governance account is recorded.
    const redo = workDir()
    writeState(redo, { network: 'local', governance: oldGovernance })
    const refused = await runScriptExpectingFailure('setup-issuer', redo, env)
    expect(refused).toMatch(/has a governance account .* but no issuance/)
    expect(refused).toMatch(/"governance" field/)
    expect(readState(redo)).toEqual({ network: 'local', governance: oldGovernance })

    // If the state is put together by hand anyway, setup:governance stops
    // before submitting anything and says the issuer's master key is still enabled.
    const cwd = workDir()
    await runScript('setup-issuer', cwd, env)
    const afterIssuer = readState(cwd)
    writeState(cwd, { ...afterIssuer, governance: oldGovernance })
    const governanceSequence = await sequenceOf(client, oldGovernance.address)
    const issuerSequence = await sequenceOf(client, afterIssuer.issuer!.address)

    const stopped = await runScriptExpectingFailure('setup-governance', cwd, env)
    expect(stopped).toMatch(/holds no MPToken for .*, and its master key is already disabled/)
    expect(stopped).toMatch(/The issuer's master key \(r\w+\) is still enabled/)
    expect(stopped).toMatch(/delete the "governance" field/)
    expect(await sequenceOf(client, oldGovernance.address)).toBe(governanceSequence)
    expect(await sequenceOf(client, afterIssuer.issuer!.address)).toBe(issuerSequence)
    expect(await isMasterKeyDisabled(client, afterIssuer.issuer!.address)).toBe(false)
    expect(readState(cwd).issuer?.masterKeyDisablePending).toBe(true)

    // The recovery the message gives: drop the old governance account and rerun.
    writeState(cwd, afterIssuer)
    await runScript('setup-governance', cwd, env)
    const done = readState(cwd)
    expect(done.governance?.address).not.toBe(oldGovernance.address)
    expect(done.issuer?.masterKeyDisablePending).toBeUndefined()
    expect(await isMasterKeyDisabled(client, afterIssuer.issuer!.address)).toBe(true)
    expect(await isHolderAdmitted(client, done.governance!.address, done.mptIssuanceId!)).toBe(true)
  }, 240_000)

  it('without RequireAuth, disables each master key in its own script as before', async () => {
    const cwd = workDir()
    const env = testEnv(network.wsUrl)

    await runScript('setup-issuer', cwd, env)
    const afterIssuer = readState(cwd)
    expect(afterIssuer.issuance).toEqual({ flags: 98, assetScale: 0 })
    expect(afterIssuer.issuer?.masterKeyDisablePending).toBeUndefined()
    expect(await isMasterKeyDisabled(client, afterIssuer.issuer!.address)).toBe(true)
    const node = await fetchMPTokenIssuance(client, afterIssuer.mptIssuanceId!, 'validated')
    expect(node.AssetScale).toBeUndefined()

    // A state file from before `issuance` was recorded: a rerun reads it from
    // the ledger and submits nothing.
    const { issuance: _issuance, ...legacy } = afterIssuer
    writeState(cwd, legacy)
    const issuerSequence = await sequenceOf(client, afterIssuer.issuer!.address)
    const migrated = await runScript('setup-issuer', cwd, env)
    expect(migrated).toMatch(/resuming/)
    expect(readState(cwd)).toEqual(afterIssuer)
    expect(await sequenceOf(client, afterIssuer.issuer!.address)).toBe(issuerSequence)

    await runScript('setup-governance', cwd, env)
    const done = readState(cwd)
    expect(await isMasterKeyDisabled(client, done.governance!.address)).toBe(true)
    const holding = await fetchMPTokenOrUndefined(client, done.governance!.address, done.mptIssuanceId!, 'validated')
    expect(holding?.Flags).toBe(0)

    const status = await runScript('status', cwd, env)
    expect(status).toMatch(/RequireAuth: no/)
    expect(status).toMatch(/Admitted by the issuer: not required/)
    expect(status).toMatch(/Both master keys disabled: yes/)
  }, 180_000)
})
