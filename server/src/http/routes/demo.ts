import { demoTicketBody, parseDemoDocName, syncTokenBody, type DemoInfo } from '@conflux/shared'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { signSyncToken } from '../../auth/syncToken'
import { createSandbox, demoDocAccess, demoState, endSandbox, joinSandbox, leaveSandbox, touchSandbox } from '../../demo/sandboxes'
import { addressKey } from '../../util/address'
import { clearGuestCookie, guest, guestCookieName, requireGuest, setGuestCookie, take, type AppContext } from '../context'
import { HttpError, forbidden, notFound } from '../errors'

export function demoRoutes(ctx: AppContext) {
  const { db, config, sync, limiters } = ctx
  const demo = config.demo
  const guarded = { preHandler: requireGuest(ctx) }
  const enabled = () => {
    if (!demo.enabled) throw notFound()
  }

  return async (app: FastifyInstance) => {
    app.get('/api/demo/info', async (): Promise<DemoInfo> => ({
      enabled: demo.enabled,
      idleMinutes: Math.round(demo.idleSeconds / 60),
      maxHours: Math.round((demo.maxSeconds / 3600) * 10) / 10,
    }))

    app.post('/api/demo/sessions', async (request, reply) => {
      enabled()
      take(limiters.demoCreate, addressKey(request.ip))
      z.strictObject({}).parse(request.body ?? {})
      const { ticket } = await createSandbox(db, demo)
      return reply.code(201).send({ ticket })
    })

    app.post('/api/demo/join', async (request, reply) => {
      enabled()
      take(limiters.demoJoin, addressKey(request.ip))
      const { ticket } = demoTicketBody.parse(request.body)
      const joined = await joinSandbox(db, demo, ticket, request.cookies[guestCookieName(config)])
      if (joined.token) setGuestCookie(reply, config, joined.token, joined.sandbox.expiresAt)
      return demoState(db, joined.participant, joined.sandbox, demo)
    })

    app.post('/api/demo/sync-token', guarded, async (request) => {
      enabled()
      const { participant, sandbox } = guest(request)
      take(limiters.demoToken, participant.id)
      const { doc } = syncTokenBody.parse(request.body)
      const pageId = parseDemoDocName(doc)
      const access = pageId ? await demoDocAccess(db, demo, participant.id, sandbox.id, pageId) : null
      if (!access) throw notFound('Page not found')
      await touchSandbox(db, demo, sandbox.id)
      const { token, expiresAt } = await signSyncToken(
        config.secret,
        { userId: participant.id, sessionId: sandbox.id, doc, kind: 'demo' },
        config.syncTokenSeconds,
      )
      return { token, expiresAt: expiresAt.toISOString() }
    })
    app.post('/api/demo/end', guarded, async (request, reply) => {
      enabled()
      const { participant, sandbox } = guest(request)
      if (!participant.isHost) throw forbidden()
      await endSandbox(db, sandbox.id)
      clearGuestCookie(reply, config)
      await sync.sweepNow()
      return reply.code(204).send()
    })
    app.post('/api/demo/leave', guarded, async (request, reply) => {
      enabled()
      const { participant } = guest(request)
      if (participant.isHost) throw new HttpError(409, 'host_cannot_leave', 'You started this demo. End it for everyone instead.')
      await leaveSandbox(db, participant.id)
      clearGuestCookie(reply, config)
      await sync.sweepNow()
      return reply.code(204).send()
    })
  }
}
