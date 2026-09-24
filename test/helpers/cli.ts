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

export function addresses(env: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    readFileSync(path.join(env.DEMO_DIR!, 'accounts.env'), 'utf8')
      .trim().split('\n').map((line) => line.replace(/^export /, '').split('=')),
  )
}
