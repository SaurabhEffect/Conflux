import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { parseAllowedOrigins } from './allowedOrigins'

export type RateLimit = { max: number; windowMs: number }

export type Config = {
  production: boolean
  host: string
  port: number
  lan: boolean
  databaseUrl: string | null
  dataDir: string
  /** Signs the short-lived sync tokens. Random per start unless CONFLUX_SECRET is set. */
  secret: Uint8Array
  secretIsRandom: boolean
  allowedOrigins: ReadonlySet<string>
  cookieSecure: boolean
  trustProxy: boolean | number
  webDist: string | null
  logLevel: string
  sessionDays: number
  syncTokenSeconds: number
  /** How often the server re-checks every open connection against the database. */
  sweepIntervalMs: number
  /** A new WebSocket must prove who it is within this time, or it is closed. */
  authDeadlineMs: number
  limits: {
    global: RateLimit
    signup: RateLimit
    login: RateLimit
    loginPerAccount: RateLimit
    invite: RateLimit
    syncToken: RateLimit
    socketUpgrades: RateLimit
    /** Password hashes the whole server will start per second. Hashing is deliberately expensive. */
    hashesPerSecond: number
    socketsPerIp: number
    socketsPerUser: number
  }
}

export class ConfigError extends Error {}

type Env = Record<string, string | undefined>

const MINUTE = 60_000
const HOUR = 60 * MINUTE

export function loadConfig(env: Env = process.env, argv: readonly string[] = process.argv): Config {
  const production = env.NODE_ENV === 'production'
  const lan = argv.includes('--lan')
  const port = integer(env, 'PORT', 1234, 0, 65535)
  const host = env.CONFLUX_HOST?.trim() || (lan ? '0.0.0.0' : '127.0.0.1')

  const secretText = env.CONFLUX_SECRET
  if (secretText !== undefined && secretText.length < 32) {
    throw new ConfigError('CONFLUX_SECRET must be at least 32 characters. Make one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64url\'))"')
  }

  const scale = integer(env, 'CONFLUX_RATE_LIMIT_SCALE', 1, 1, 10_000)
  const rate = (max: number, windowMs: number): RateLimit => ({ max: max * scale, windowMs })

  const ownOrigins = [`http://localhost:${port}`, `http://127.0.0.1:${port}`]
  const defaultOrigins = ['http://localhost:5173', 'http://127.0.0.1:5173', ...ownOrigins]

  return {
    production,
    host,
    port,
    lan,
    databaseUrl: env.DATABASE_URL?.trim() || null,
    dataDir: env.CONFLUX_DATA_DIR?.trim() || fileURLToPath(new URL('../data/pglite', import.meta.url)),
    secret: secretText ? new TextEncoder().encode(secretText) : randomBytes(32),
    secretIsRandom: !secretText,
    allowedOrigins: parseAllowedOrigins(env.CONFLUX_ALLOWED_ORIGINS, defaultOrigins),
    cookieSecure: bool(env, 'CONFLUX_COOKIE_SECURE', production),
    trustProxy: trustProxy(env),
    webDist: webDist(env),
    logLevel: env.CONFLUX_LOG_LEVEL?.trim() || (env.NODE_ENV === 'test' ? 'silent' : 'info'),
    sessionDays: 30,
    syncTokenSeconds: 60,
    sweepIntervalMs: 2000,
    authDeadlineMs: 10_000,
    limits: {
      global: rate(600, MINUTE),
      signup: rate(10, HOUR),
      login: rate(20, 10 * MINUTE),
      loginPerAccount: rate(6, 10 * MINUTE),
      invite: rate(30, MINUTE),
      syncToken: rate(300, MINUTE),
      socketUpgrades: rate(60, MINUTE),
      hashesPerSecond: 10 * scale,
      socketsPerIp: 200,
      socketsPerUser: 40,
    },
  }
}

function integer(env: Env, name: string, fallback: number, min: number, max: number): number {
  const raw = env[name]?.trim()
  if (!raw) return fallback
  const value = Number(raw)
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new ConfigError(`${name} must be a whole number between ${min} and ${max} (got "${raw}")`)
  }
  return value
}

function bool(env: Env, name: string, fallback: boolean): boolean {
  const raw = env[name]?.trim().toLowerCase()
  if (!raw) return fallback
  if (raw === 'true' || raw === '1') return true
  if (raw === 'false' || raw === '0') return false
  throw new ConfigError(`${name} must be true or false (got "${raw}")`)
}

/** false = ignore proxy headers. A number = trust that many proxies in front of the server. */
function trustProxy(env: Env): boolean | number {
  const raw = env.CONFLUX_TRUST_PROXY?.trim().toLowerCase()
  if (!raw || raw === 'false' || raw === '0') return false
  if (raw === 'true') return true
  const hops = Number(raw)
  if (Number.isInteger(hops) && hops > 0) return hops
  throw new ConfigError(`CONFLUX_TRUST_PROXY must be true, false or a number of proxies (got "${raw}")`)
}

function webDist(env: Env): string | null {
  const configured = env.CONFLUX_WEB_DIST?.trim()
  if (configured) return configured
  const built = fileURLToPath(new URL('../../web/dist', import.meta.url))
  return existsSync(built) ? built : null
}
