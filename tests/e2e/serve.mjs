import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const port = process.env.E2E_PORT ?? '4321'
const dataDir = mkdtempSync(path.join(os.tmpdir(), 'conflux-e2e-'))

if (!process.env.E2E_SKIP_BUILD) {
  const build = spawnSync('npm', ['run', 'build'], { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' })
  if (build.status !== 0) process.exit(build.status ?? 1)
}

const server = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', '--import', 'tsx', 'src/index.ts'], {
  cwd: path.join(root, 'server'),
  stdio: 'inherit',
  env: {
    ...process.env,
    NODE_ENV: 'development',
    PORT: port,
    CONFLUX_DATA_DIR: dataDir,
    CONFLUX_LOG_LEVEL: 'warn',
    CONFLUX_RATE_LIMIT_SCALE: '100',
  },
})

let finished = false
function finish(code) {
  if (finished) return
  finished = true
  server.kill()
  setTimeout(() => {
    rmSync(dataDir, { recursive: true, force: true })
    process.exit(code)
  }, 500)
}
server.on('exit', (code) => finish(code ?? 0))
process.on('SIGINT', () => finish(0))
process.on('SIGTERM', () => finish(0))
