// Node only loads dotenv syntax as data; it does not build or sign transactions.
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

if (existsSync('.env')) process.loadEnvFile('.env')
const result = spawnSync('bash', [
  fileURLToPath(new URL('./token.sh', import.meta.url)),
  ...process.argv.slice(2),
], { stdio: 'inherit' })
if (result.error) throw result.error
process.exitCode = result.status ?? 1
