import { syncTokenBody } from '@conflux/shared'
import type { FastifyInstance } from 'fastify'
import { docAccess } from '../../access'
import { signSyncToken } from '../../auth/syncToken'
import { ping } from '../../db/client'
import { me, requireAuth, take, type AppContext } from '../context'
import { HttpError, notFound } from '../errors'
export function syncTokenRoutes(ctx: AppContext) {
  const { db, config, limiters } = ctx
  return async (app: FastifyInstance) => {
    app.post('/api/sync-token', { preHandler: requireAuth(ctx) }, async (request) => {
      const auth = me(request)
      take(limiters.syncToken, auth.user.id)
      const { doc } = syncTokenBody.parse(request.body)
      const access = await docAccess(db, auth.user.id, doc)
      if (!access) throw notFound('Document not found')
      const { token, expiresAt } = await signSyncToken(config.secret, { userId: auth.user.id, sessionId: auth.sessionId, doc }, config.syncTokenSeconds)
      return { token, expiresAt: expiresAt.toISOString() }
    })
    const health = async () => {
      try {
        await ping(db)
      } 
      catch {
        throw new HttpError(503, 'unhealthy', 'Database is not reachable')
      }
      return { ok: true, version: ctx.version }
    }
    app.get('/api/health', health)
    app.get('/health', health)
  }
}
