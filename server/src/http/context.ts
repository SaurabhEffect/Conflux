import type { FastifyReply, FastifyRequest } from 'fastify'
import type { AuthContext } from '../auth/sessions'
import { findSession } from '../auth/sessions'
import type { Config } from '../config'
import type { Db } from '../db/client'
import type { Sync } from '../sync/server'
import type { Budget, RateLimiter } from '../util/limiter'
import { HttpError, busy, tooManyRequests, unauthorized } from './errors'

export type Limiters = {
  global: RateLimiter
  signup: RateLimiter
  login: RateLimiter
  loginPerAccount: RateLimiter
  invite: RateLimiter
  syncToken: RateLimiter
}

export type AppContext = {
  config: Config
  db: Db
  sync: Pick<Sync, 'sweepNow' | 'notifyWorkspace'>
  limiters: Limiters
  hashBudget: Budget
  version: string
}

declare module 'fastify' {
  interface FastifyRequest {
    auth: AuthContext | null
  }
}

export const sessionCookieName = (config: Config) => (config.cookieSecure ? '__Host-conflux_session' : 'conflux_session')

export function setSessionCookie(reply: FastifyReply, config: Config, token: string, expiresAt: Date) {
    reply.setCookie(sessionCookieName(config), token, {
    httpOnly: true,
    secure: config.cookieSecure,
    sameSite: 'lax',
    path: '/',
    expires: expiresAt,
  })
}

export function clearSessionCookie(reply: FastifyReply, config: Config) {
  reply.clearCookie(sessionCookieName(config), { httpOnly: true, secure: config.cookieSecure, sameSite: 'lax', path: '/' })
}

export function requireAuth(ctx: AppContext) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const token = request.cookies[sessionCookieName(ctx.config)]
    const auth = token ? await findSession(ctx.db, token, ctx.config.sessionDays) : null
    if (!auth) throw unauthorized()
    request.auth = auth
    // The session was just extended on the server. Extend the cookie too, or the browser drops it on the original date.
    if (token && auth.renewedUntil) setSessionCookie(reply, ctx.config, token, auth.renewedUntil)
  }
}

export function me(request: FastifyRequest): AuthContext {
  if (!request.auth) throw unauthorized()
  return request.auth
}

export function take(limiter: RateLimiter, key: string) {
  const result = limiter.take(key)
  if (!result.ok) throw tooManyRequests(result.retryAfterSeconds)
}

export function takeHash(ctx: AppContext) {
  if (!ctx.hashBudget.tryTake()) throw busy()
}

export type { HttpError }
