// Remove this source bootstrap when the CLI stack has an installable release.
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const pin = JSON.parse(readFileSync(new URL('../cli.json', import.meta.url), 'utf8'))
const directory = fileURLToPath(new URL('../.prototype/xrpl-rust', import.meta.url))
const run = (command, args, cwd = directory) => execFileSync(command, args, { cwd, stdio: 'inherit' })
mkdirSync(new URL('../.prototype/', import.meta.url), { recursive: true })
if (!existsSync(directory)) {
  run('git', ['clone', '--no-checkout', '--filter=blob:none', pin.repository, directory], root)
} else if (execFileSync('git', ['status', '--porcelain'], { cwd: directory, encoding: 'utf8' }).trim()) {
  throw new Error('The CLI checkout has local changes; save them before running setup.')
}
run('git', ['fetch', '--depth=1', 'origin', pin.commit])
run('git', ['checkout', '--detach', pin.commit])
// Upstream ignores Cargo.lock. Keep our dependency resolution alongside the pin.
copyFileSync(new URL('../cli/Cargo.lock', import.meta.url), directory + '/Cargo.lock')
run('cargo', ['build', '--locked', '--release', '-p', 'xrpl-cli'])
console.log('Built the pinned xrpl CLI. npm run setup:issuer is ready.')
