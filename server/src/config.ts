import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { DEMO_BOT_REPLY_DELAY_MS } from '@conflux/shared'
import { parseAllowedOrigins } from './allowedOrigins'

export type RateLimit = { max: number; windowMs: number }

export type Config = {
  production: boolean
  host: string
  port: number
  lan: boolean
  databaseUrl: string | null
  dataDir: string
  secret: Uint8Array
  secretIsRandom: boolean
  allowedOrigins: ReadonlySet<string>
  cookieSecure: boolean
  trustProxy: boolean | number
  webDist: string | null
  logLevel: string
  sessionDays: number
  syncTokenSeconds: number
  sweepIntervalMs: number
  authDeadlineMs: number
  demo: {
    enabled: boolean
    idleSeconds: number
    maxSeconds: number
    maxActive: number
    botReplyDelayMs: number
    botTypeDelayMs: number
    botMaxReplies: number
  }
  limits: {
    global: RateLimit
    signup: RateLimit
    login: RateLimit
    loginPerAccount: RateLimit
    invite: RateLimit
    syncToken: RateLimit
    demoCreate: RateLimit
    demoJoin: RateLimit
    demoToken: RateLimit
    socketUpgrades: RateLimit
    messagesPerSecond: number
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
    demo: {
      enabled: bool(env, 'CONFLUX_DEMO', true),
      idleSeconds: integer(env, 'CONFLUX_DEMO_IDLE_MINUTES', 30, 1, 24 * 60) * 60,
      maxSeconds: integer(env, 'CONFLUX_DEMO_MAX_HOURS', 3, 1, 72) * 3600,
      maxActive: integer(env, 'CONFLUX_DEMO_MAX_ACTIVE', 100, 1, 10_000),
      botReplyDelayMs: DEMO_BOT_REPLY_DELAY_MS,
      botTypeDelayMs: 35,
      botMaxReplies: 30,
    },
    limits: {
      global: rate(600, MINUTE),
      signup: rate(10, HOUR),
      login: rate(20, 10 * MINUTE),
      loginPerAccount: rate(6, 10 * MINUTE),
      invite: rate(30, MINUTE),
      syncToken: rate(300, MINUTE),
      demoCreate: rate(5, HOUR),
      demoJoin: rate(60, 10 * MINUTE),
      demoToken: rate(300, MINUTE),
      socketUpgrades: rate(60, MINUTE),
      messagesPerSecond: 100 * scale,
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
