import { LIMITS, can, createPageBody, updatePageBody, type PageDto } from '@conflux/shared'
import { and, asc, count, eq, isNull, max, sql } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { pageAccess } from '../../access'
import { pages } from '../../db/schema'
import { me, requireAuth, type AppContext } from '../context'
import { toPageDto } from '../dto'
import { HttpError, forbidden, notFound } from '../errors'
import { authorizeWorkspace, idParam, withWorkspaceLock } from '../guards'

export function pageRoutes(ctx: AppContext) {
  const { db, sync } = ctx
  const authed = { preHandler: requireAuth(ctx) }
  return async (app: FastifyInstance) => {
    app.get('/api/workspaces/:id/pages', authed, async (request) => {
      const { user } = me(request)
      const workspaceId = idParam((request.params as { id?: string }).id)
      await authorizeWorkspace(db, user.id, workspaceId, 'page:read')
      const rows = await db
        .select()
        .from(pages)
        .where(and(eq(pages.workspaceId, workspaceId), isNull(pages.deletedAt)))
        .orderBy(asc(pages.position), asc(pages.createdAt), asc(pages.id))
      const list: PageDto[] = rows.map(toPageDto)
      return { pages: list }
    })

    app.post('/api/workspaces/:id/pages', authed, async (request, reply) => {
      const { user } = me(request)
      const workspaceId = idParam((request.params as { id?: string }).id)
      const body = createPageBody.parse(request.body)
      const page = await withWorkspaceLock(db, user.id, workspaceId, 'page:create', async (tx) => {
        const [stats] = await tx
          .select({ total: count(), last: max(pages.position) })
          .from(pages)
          .where(and(eq(pages.workspaceId, workspaceId), isNull(pages.deletedAt)))
        if (stats.total >= LIMITS.maxPagesPerWorkspace) {
          throw new HttpError(403, 'quota_exceeded', `A workspace can have up to ${LIMITS.maxPagesPerWorkspace} pages`)
        }
        const [row] = await tx
          .insert(pages)
          .values({ workspaceId, title: body.title, position: (stats.last ?? -1) + 1, createdBy: user.id })
          .returning()
        return row
      })
      sync.notifyWorkspace(workspaceId, 'pages')
      return reply.code(201).send(toPageDto(page))
    })

    app.patch('/api/pages/:id', authed, async (request) => {
      const { user } = me(request)
      const pageId = idParam((request.params as { id?: string }).id)
      const body = updatePageBody.parse(request.body)
      const access = await pageAccess(db, user.id, pageId)
      if (!access) throw notFound('Page not found')
      if (!can(access.role, 'page:edit')) throw forbidden()
      const [updated] = await db
        .update(pages)
        .set({ title: body.title, updatedAt: sql`now()` })
        .where(and(eq(pages.id, pageId), isNull(pages.deletedAt)))
        .returning()
      if (!updated) throw notFound('Page not found')
      sync.notifyWorkspace(access.page.workspaceId, 'pages')
      return toPageDto(updated)
    })
    app.delete('/api/pages/:id', authed, async (request, reply) => {
      const { user } = me(request)
      const pageId = idParam((request.params as { id?: string }).id)
      const access = await pageAccess(db, user.id, pageId)
      if (!access) throw notFound('Page not found')
      if (!can(access.role, 'page:delete')) throw forbidden()
      await db.update(pages).set({ deletedAt: sql`now()` }).where(and(eq(pages.id, pageId), isNull(pages.deletedAt)))
      request.log.info({ user: user.id, page: pageId }, 'page deleted')
      await sync.sweepNow()
      sync.notifyWorkspace(access.page.workspaceId, 'pages')
      return reply.code(204).send()
    })
  }
}
