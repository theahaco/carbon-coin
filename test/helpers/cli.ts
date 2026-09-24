import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'

export const root = fileURLToPath(new URL('../../', import.meta.url))
const exec = promisify(execFile)

export function cliEnvironment(extra: NodeJS.ProcessEnv = {}) {
  const directory = mkdtempSync(path.join(tmpdir(), 'carbon-cli-'))
  return {
    directory,
    env: {
      ...process.env,
      XRPL_BIN: process.env.XRPL_BIN ?? path.join(root, '.prototype/xrpl-rust/target/release/xrpl'),
      XRPL_NETWORK: 'local',
      XRPL_DATA_DIR: path.join(directory, 'data'),
      XRPL_CONFIG_DIR: path.join(directory, 'config'),
      XRPL_PASSPHRASE: 'disposable-test-passphrase',
      TOKEN_STATE_FILE: path.join(directory, 'deployment.json'),
      TOKEN_PUBLIC_CONFIG: path.join(directory, 'public.json'),
      TOKEN_TICKER: 'TEST',
      TOKEN_NAME: 'Test Token',
      TOKEN_DESCRIPTION: 'A test token',
      TOKEN_ICON_URL: 'https://example.org/icon.png',
      TOKEN_ASSET_CLASS: 'other',
      TOKEN_ASSET_SUBCLASS: 'other',
      TOKEN_ISSUER_NAME: 'Test Issuer',
      ISSUER_SIGNER_ADDRESSES: '',
      GOVERNANCE_SIGNER_ADDRESSES: '',
      ...extra,
    } as NodeJS.ProcessEnv,
  }
}

export async function token(env: NodeJS.ProcessEnv, ...args: string[]) {
  return exec(process.execPath, [path.join(root, 'scripts/run.mjs'), ...args], {
    cwd: root, env, timeout: 240_000, maxBuffer: 4 * 1024 * 1024,
  })
}

export function deployment(env: NodeJS.ProcessEnv) {
  return JSON.parse(readFileSync(env.TOKEN_STATE_FILE!, 'utf8'))
}
