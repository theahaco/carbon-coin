import { afterEach, describe, expect, it } from 'vitest'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { cliEnvironment, root, token } from '../helpers/cli.js'

const directories: string[] = []
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }) })
function fixture(extra = {}) {
  const context = cliEnvironment(extra)
  directories.push(context.directory)
  return context.env
}

describe('CLI application boundaries', () => {
  it('exports only public fields, even from a state containing nested secrets', async () => {
    const env = fixture()
    writeFileSync(env.TOKEN_STATE_FILE!, JSON.stringify({
      version: 2, network: 'local', mptIssuanceId: 'A'.repeat(48),
      issuer: { address: 'rIssuer', key: 'private-key-name', seed: 'secret', quorum: 2,
        signers: [{ address: 'rSigner', seed: 'nested-secret', key: 'another-key' }] },
      pending: { transaction: { Signers: [{ TxnSignature: 'signature' }] } },
    }))
    await token(env, 'web:sync-config')
    const raw = readFileSync(env.TOKEN_PUBLIC_CONFIG!, 'utf8')
    const output = JSON.parse(raw)
    expect(output.issuer).toEqual({ address: 'rIssuer', quorum: 2, signers: [{ address: 'rSigner' }] })
    expect(output.governance).toBeUndefined()
    expect(output.token.ticker).toBe('TEST')
    expect(raw).not.toMatch(/secret|private-key|another-key|signature|pending/)
  })

  it('refuses a network mismatch before invoking a CLI', async () => {
    const env = fixture({ XRPL_BIN: '/does-not-exist' })
    writeFileSync(env.TOKEN_STATE_FILE!, '{"version":2,"network":"testnet"}')
    await expect(token(env, 'mint', '1')).rejects.toThrow(/another network/)
  })

  it('requires explicit migration of legacy seeds', async () => {
    const env = fixture({ XRPL_BIN: '/does-not-exist' })
    writeFileSync(env.TOKEN_STATE_FILE!, '{"network":"local","issuer":{"seed":"secret"}}')
    await expect(token(env, 'mint', '1')).rejects.toThrow(/deployment:import/)
    expect(readFileSync(env.TOKEN_STATE_FILE!, 'utf8')).toContain('secret')
  })

  it('validates required metadata and the ledger byte limit before enrolment', async () => {
    const env = fixture({ TOKEN_NAME: 'x'.repeat(1100) })
    await expect(token(env, 'setup:issuer')).rejects.toThrow(/exceeds 1024 bytes/)
  })

  it('encodes XLS-89 compact metadata with all configured fields', () => {
    const env = fixture()
    const output = execFileSync('jq', ['-n', '-f', path.join(root, 'scripts/metadata.jq')], { env, encoding: 'utf8' })
    expect(JSON.parse(output)).toEqual({
      t: 'TEST', n: 'Test Token', d: 'A test token', i: 'https://example.org/icon.png',
      ac: 'other', as: 'other', in: 'Test Issuer',
    })
  })
})
