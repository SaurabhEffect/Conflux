import {
  LIMITS,
  createWorkspaceBody,
  updateMemberBody,
  updateWorkspaceBody,
  type MemberDto,
  type WorkspaceDto,
} from '@conflux/shared'
import { and, asc, count, eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { memberships, users, workspaces } from '../../db/schema'
import { me, requireAuth, type AppContext } from '../context'
import { toMemberDto, toWorkspaceDto } from '../dto'
import { HttpError, conflict, notFound } from '../errors'
import { authorizeWorkspace, idParam, withWorkspaceLock } from '../guards'

export function workspaceRoutes(ctx: AppContext) {
  const { db, sync } = ctx
  const authed = { preHandler: requireAuth(ctx) }
  return async (app: FastifyInstance) => {
    app.post('/api/workspaces', authed, async (request, reply) => {
      const { user } = me(request)
      const body = createWorkspaceBody.parse(request.body)
      const created = await db.transaction(async (tx) => {
        await tx.select({ id: users.id }).from(users).where(eq(users.id, user.id)).for('update')
        const [{ owned }] = await tx
          .select({ owned: count() })
          .from(memberships)
          .where(and(eq(memberships.userId, user.id), eq(memberships.role, 'owner')))
        if (owned >= LIMITS.maxOwnedWorkspaces) {
          throw new HttpError(403, 'quota_exceeded', `You can own up to ${LIMITS.maxOwnedWorkspaces} workspaces`)
        }
        const [workspace] = await tx.insert(workspaces).values({ name: body.name, createdBy: user.id }).returning()
        await tx.insert(memberships).values({ workspaceId: workspace.id, userId: user.id, role: 'owner' })
        return workspace
      })
      const response: WorkspaceDto = toWorkspaceDto(created, 'owner')
      return reply.code(201).send(response)
    })

    app.get('/api/workspaces/:id', authed, async (request) => {
      const { user } = me(request)
      const id = idParam((request.params as { id?: string }).id)
      const role = await authorizeWorkspace(db, user.id, id, 'workspace:read')
      const [workspace] = await db.select().from(workspaces).where(eq(workspaces.id, id))
      if (!workspace) throw notFound('Workspace not found')
      return toWorkspaceDto(workspace, role)
    })

    app.patch('/api/workspaces/:id', authed, async (request) => {
      const { user } = me(request)
      const id = idParam((request.params as { id?: string }).id)
      const body = updateWorkspaceBody.parse(request.body)
      const updated = await withWorkspaceLock(db, user.id, id, 'workspace:rename', async (tx, role) => {
        const [workspace] = await tx.update(workspaces).set({ name: body.name }).where(eq(workspaces.id, id)).returning()
        return toWorkspaceDto(workspace, role)
      })
      sync.notifyWorkspace(id, 'workspace')
      return updated
    })

    app.delete('/api/workspaces/:id', authed, async (request, reply) => {
      const { user } = me(request)
      const id = idParam((request.params as { id?: string }).id)
      await withWorkspaceLock(db, user.id, id, 'workspace:delete', async (tx) => {
        await tx.delete(workspaces).where(eq(workspaces.id, id))
      })
      request.log.info({ user: user.id, workspace: id }, 'workspace deleted')
      await sync.sweepNow()
      return reply.code(204).send()
    })

    app.get('/api/workspaces/:id/members', authed, async (request) => {
      const { user } = me(request)
      const id = idParam((request.params as { id?: string }).id)
      const role = await authorizeWorkspace(db, user.id, id, 'members:read')
      const rows = await db
        .select({
          userId: users.id,
          displayName: users.displayName,
          cursorColor: users.cursorColor,
          email: users.email,
          role: memberships.role,
          joinedAt: memberships.createdAt,
        })
        .from(memberships)
        .innerJoin(users, eq(users.id, memberships.userId))
        .where(eq(memberships.workspaceId, id))
        .orderBy(asc(memberships.createdAt), asc(users.id))
      const members: MemberDto[] = rows.map((row) => toMemberDto(row, role === 'owner'))
      return { members }
    })

    app.patch('/api/workspaces/:id/members/:userId', authed, async (request) => {
      const { user } = me(request)
      const params = request.params as { id?: string; userId?: string }
      const id = idParam(params.id)
      const targetId = idParam(params.userId)
      const body = updateMemberBody.parse(request.body)
      await withWorkspaceLock(db, user.id, id, 'members:manage', async (tx) => {
        const [target] = await tx
          .select()
          .from(memberships)
          .where(and(eq(memberships.workspaceId, id), eq(memberships.userId, targetId)))
        if (!target) throw notFound('Member not found')
        if (target.role === 'owner' && body.role !== 'owner') await assertAnotherOwner(tx, id)
        await tx
          .update(memberships)
          .set({ role: body.role })
          .where(and(eq(memberships.workspaceId, id), eq(memberships.userId, targetId)))
      })
      request.log.info({ user: user.id, workspace: id, target: targetId, role: body.role }, 'member role changed')
      await sync.sweepNow()
      sync.notifyWorkspace(id, 'members')
      return { ok: true }
    })

    app.delete('/api/workspaces/:id/members/:userId', authed, async (request, reply) => {
      const { user } = me(request)
      const params = request.params as { id?: string; userId?: string }
      const id = idParam(params.id)
      const targetId = idParam(params.userId)
      const leaving = targetId === user.id

      await withWorkspaceLock(db, user.id, id, leaving ? 'workspace:leave' : 'members:manage', async (tx) => {
        const [target] = await tx
          .select()
          .from(memberships)
          .where(and(eq(memberships.workspaceId, id), eq(memberships.userId, targetId)))
        if (!target) throw notFound('Member not found')
        if (target.role === 'owner') await assertAnotherOwner(tx, id)
        await tx.delete(memberships).where(and(eq(memberships.workspaceId, id), eq(memberships.userId, targetId)))
      })
      request.log.info({ user: user.id, workspace: id, target: targetId }, leaving ? 'member left' : 'member removed')
      await sync.sweepNow()
      sync.notifyWorkspace(id, 'members')
      return reply.code(204).send()
    })
  }
}

async function assertAnotherOwner(tx: Parameters<typeof authorizeWorkspace>[0], workspaceId: string) {
  const [{ owners }] = await tx
    .select({ owners: count() })
    .from(memberships)
    .where(and(eq(memberships.workspaceId, workspaceId), eq(memberships.role, 'owner')))
  if (owners <= 1) throw conflict('last_owner', 'A workspace needs at least one owner. Make someone else an owner first, or delete the workspace.')
}
