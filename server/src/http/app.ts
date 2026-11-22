import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import cookie from '@fastify/cookie'
import helmet from '@fastify/helmet'
import fastifyStatic from '@fastify/static'
import Fastify, { LogController, type FastifyInstance, type FastifyRequest, type FastifyServerOptions } from 'fastify'
import { ZodError } from 'zod'
import { isAllowedOrigin } from '../allowedOrigins'
import type { Config } from '../config'
import type { Db } from '../db/client'
import { createSync, type Sync } from '../sync/server'
import { addressKey } from '../util/address'
import { Budget, RateLimiter } from '../util/limiter'
import { take, type AppContext } from './context'
import { HttpError } from './errors'
import { authRoutes } from './routes/auth'
import { inviteRoutes } from './routes/invites'
import { pageRoutes } from './routes/pages'
import { syncTokenRoutes } from './routes/syncToken'
import { workspaceRoutes } from './routes/workspaces'

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])
export const serverVersion: string = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version
export async function buildApp(config: Config, db: Db): Promise<{ app: FastifyInstance; sync: Sync }> {
  const hops = config.trustProxy === true ? 1 : config.trustProxy
  const options: FastifyServerOptions = {
    logger: { level: config.logLevel, redact: ['req.headers.cookie', 'req.headers.authorization'] },
    trustProxy: hops === false ? false : (_address: string, hop: number) => hop < hops,
    logController: new LogController({ disableRequestLogging: true }),
    bodyLimit: 64 * 1024,
    genReqId: () => randomUUID().slice(0, 8),
  }
  const app = Fastify(options)
  const sync = createSync({ config, db, log: app.log.child({ component: 'sync' }) })
  const ctx: AppContext = {
    config,
    db,
    sync,
    version: serverVersion,
    hashBudget: new Budget(config.limits.hashesPerSecond),
    limiters: {
      global: new RateLimiter(config.limits.global),
      signup: new RateLimiter(config.limits.signup),
      login: new RateLimiter(config.limits.login),
      loginPerAccount: new RateLimiter(config.limits.loginPerAccount),
      invite: new RateLimiter(config.limits.invite),
      syncToken: new RateLimiter(config.limits.syncToken),
    },
  }
  await app.register(cookie)
  await app.register(helmet, {
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        'default-src': ["'self'"],
        'script-src': ["'self'"],
        // The editor sets small inline styles (cursor colours, avatars).
        'style-src': ["'self'", "'unsafe-inline'"],
        'img-src': ["'self'", 'data:'],
        'font-src': ["'self'"],
        'connect-src': ["'self'", ...[...config.allowedOrigins].map((origin) => origin.replace(/^http/, 'ws'))],
        'object-src': ["'none'"],
        'base-uri': ["'none'"],
        'form-action': ["'self'"],
        'frame-ancestors': ["'none'"],
      },
    },
    referrerPolicy: { policy: 'no-referrer' },
    hsts: config.cookieSecure ? { maxAge: 15_552_000 } : false,
    crossOriginEmbedderPolicy: false,
    crossOriginOpenerPolicy: { policy: 'same-origin' },
    crossOriginResourcePolicy: { policy: 'same-origin' },
  })

  app.removeContentTypeParser('text/plain')
  app.decorateRequest('auth', null)
  app.addHook('onRequest', async (request, reply) => {
    if (SAFE_METHODS.has(request.method)) return
    reply.header('Cache-Control', 'no-store')
    rejectForeignSites(request, config)
  })

  app.setNotFoundHandler((request, reply) => {
    const isApi = request.url.startsWith('/api/') || request.url.startsWith('/collab')
    if (!isApi && config.webDist && request.method === 'GET') return reply.sendFile('index.html')
    return reply.code(404).send({ error: { code: 'not_found', message: 'Not found' } })
  })

  app.setErrorHandler((error: Error & { statusCode?: number; code?: string }, request, reply) => {
    if (error instanceof ZodError) {
      const issues = error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message }))
      return reply.code(400).send({ error: { code: 'invalid_input', message: issues[0]?.message ?? 'Invalid input', issues } })
    }
    if (error instanceof HttpError) {
      if (error.headers) reply.headers(error.headers)
      return reply.code(error.status).send({ error: { code: error.code, message: error.message } })
    }
    const status = error.statusCode ?? 500
    if (status >= 400 && status < 500) {
      const code = status === 413 ? 'too_large' : status === 415 ? 'unsupported_media_type' : 'bad_request'
      const message = status === 413 ? 'The request is too large' : status === 415 ? 'Send JSON (Content-Type: application/json)' : 'The request could not be understood'
      return reply.code(status).send({ error: { code, message } })
    }
    request.log.error({ err: error }, 'unhandled error')
    return reply.code(500).send({ error: { code: 'internal', message: 'Something went wrong on our side' } })
  })
  await app.register(async (api) => {
    api.addHook('onRequest', async (request, reply) => {
      reply.header('Cache-Control', 'no-store')
      take(ctx.limiters.global, addressKey(request.ip))
    })
    await api.register(authRoutes(ctx))
    await api.register(workspaceRoutes(ctx))
    await api.register(inviteRoutes(ctx))
    await api.register(pageRoutes(ctx))
    await api.register(syncTokenRoutes(ctx))
  })

  if (config.webDist) {
    await app.register(fastifyStatic, {
      root: config.webDist,
      wildcard: false,
      setHeaders(res, filePath) {
        const hashed = filePath.includes(`${path.sep}assets${path.sep}`)
        res.header('Cache-Control', hashed ? 'public, max-age=31536000, immutable' : 'no-cache')
      },
    })
  }
  app.addHook('preClose', async () => {
    await sync.close()
  })

  return { app, sync }
}

function rejectForeignSites(request: FastifyRequest, config: Config) {
  const origin = request.headers.origin
  const site = request.headers['sec-fetch-site']
  if ((origin !== undefined && !isAllowedOrigin(origin, config.allowedOrigins)) || site === 'cross-site') {
    throw new HttpError(403, 'bad_origin', 'This request came from a website that is not allowed')
  }
}
