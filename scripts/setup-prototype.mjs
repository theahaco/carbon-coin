// Temporary bootstrap for the unpublished SDK prototype: npm cannot install
// packages/xrpl directly from a Git dependency on the monorepo, so this builds
// the pinned checkout for the root and web file: dependencies. Prototype:
// https://github.com/theahaco/xrpl.js/pull/57
// Remove this script and its npm/CI hooks once both consumers use an installable
// SDK release or prebuilt package with matching runtime dependencies and types.
// SDK follow-up (still source-pinned): https://github.com/theahaco/carbon-coin/pull/10
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const pin = JSON.parse(readFileSync(new URL('../prototype.json', import.meta.url), 'utf8'))
const directory = fileURLToPath(new URL('../.prototype/xrpl.js', import.meta.url))
const run = (command, args, cwd = directory) => execFileSync(command, args, { cwd, stdio: 'inherit' })
mkdirSync(new URL('../.prototype/', import.meta.url), { recursive: true })
if (!existsSync(directory)) {
  run('git', ['clone', '--no-checkout', '--filter=blob:none', pin.repository, directory], root)
} else {
  const dirty = execFileSync('git', ['status', '--porcelain'], { cwd: directory, encoding: 'utf8' })
  if (dirty.trim()) throw new Error('The prototype checkout has local changes; save them before running setup.')
}
run('git', ['fetch', '--depth=1', 'origin', pin.commit])
run('git', ['checkout', '--detach', pin.commit])
run('npm', ['ci'])
run('npm', ['run', 'build'])
console.log(`Built aha xrpl.js prototype at ${pin.commit}. Next: npm ci && npm --prefix web ci`)
