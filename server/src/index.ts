import { buildApp } from './http/app'
import { ConfigError, loadConfig, type Config } from './config'
import { openDatabase } from './db/client'
import { startMaintenance } from './maintenance'

let config: Config
try {
  config = loadConfig()
} catch (error) {
  if (error instanceof ConfigError) {
    console.error(`\n  ${error.message}\n`)
    process.exit(1)
  }
  throw error
}

const log = (message: string) => console.log(`[${new Date().toLocaleTimeString()}] ${message}`)

const database = await openDatabase({
  url: config.databaseUrl,
  dataDir: config.dataDir,
  onError: (error) => console.error('Database connection problem:', error.message),
}).catch((error: Error) => {
  console.error(`\n  Could not open the database (${config.databaseUrl ? 'DATABASE_URL' : config.dataDir}).\n  ${error.message}\n`)
  process.exit(1)
})

const { app, sync } = await buildApp(config, database.db)
sync.attach(app.server)
const stopMaintenance = startMaintenance(database.db, app.log)

try {
  await app.listen({ port: config.port, host: config.host })
} catch (error) {
  if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE') {
    console.error(
      `\n  Port ${config.port} is already in use. Another copy of Conflux (or another program) is running.\n` +
        `  Close it, or start on a different port with the PORT setting. See the README.\n`,
    )
  } else {
    console.error(error)
  }
  process.exit(1)
}

console.log(`
  Conflux is running
    Server    : http://localhost:${config.port}   (API and live sync at /collab)
    Web app   : ${config.webDist ? `http://localhost:${config.port}` : 'run "npm run dev" and open http://localhost:5173'}
    Database  : ${database.description}
    Reachable : ${config.lan ? 'from your whole network (--lan)' : 'from this computer only'}
`)
if (config.secretIsRandom && config.production) {
  console.log('  Note: CONFLUX_SECRET is not set, so a random one is used and changes every start. Set it if you run more than one server.\n')
}

let stopping = false
async function shutdown(signal: string) {
  if (stopping) return
  stopping = true
  log(`${signal}: saving open pages and shutting down...`)
  const force = setTimeout(() => process.exit(1), 15_000)
  force.unref()
  try {
    stopMaintenance()
    await app.close()
    await database.close()
    log('stopped. All pages are saved.')
    process.exit(0)
  } catch (error) {
    console.error('Shutdown problem:', error)
    process.exit(1)
  }
}
process.on('SIGINT', () => void shutdown('SIGINT'))
process.on('SIGTERM', () => void shutdown('SIGTERM'))
