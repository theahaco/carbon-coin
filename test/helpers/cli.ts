import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'

export const root = fileURLToPath(new URL('../../', import.meta.url))
const exec = promisify(execFile)

export function cliEnvironment(extra: NodeJS.ProcessEnv = {}) {
  const directory = mkdtempSync(path.join(tmpdir(), 'carbon-cli-'))
  return {
    directory,
    env: {
      ...process.env,
      DEMO_DIR: directory,
      ...extra,
    } as NodeJS.ProcessEnv,
  }
}

export async function demo(env: NodeJS.ProcessEnv, script: string) {
  return exec('bash', [path.join(root, 'scripts', script)], {
    cwd: root, env, timeout: 240_000, maxBuffer: 4 * 1024 * 1024,
  })
}

export async function accountRecords(env: NodeJS.ProcessEnv) {
  const { stdout } = await exec(
    path.join(root, '.prototype/xrpl-rust/target/release/xrpl'),
    ['account', 'ls', '--json'],
    { cwd: root, env: {
      ...env,
      XRPL_DATA_DIR: path.join(env.DEMO_DIR!, 'keys'),
      XRPL_CONFIG_DIR: path.join(env.DEMO_DIR!, 'config'),
    } },
  )
  return JSON.parse(stdout) as {
    alias: string
    address: string
    keys: string[]
    network_id: number
  }[]
}
