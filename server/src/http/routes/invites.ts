import {
  LIMITS,
  createInviteBody,
  inviteTokenBody,
  type InviteDto,
  type InvitePreview,
  type WorkspaceDto,
} from '@conflux/shared'
import { and, asc, count, eq, gt, isNull, sql } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { hashToken, newToken } from '../../auth/sessions'
import { invites, memberships, users, workspaces } from '../../db/schema'
import { addressKey } from '../../util/address'
import { me, requireAuth, take, type AppContext } from '../context'
import { toInviteDto, toWorkspaceDto } from '../dto'
import { HttpError, notFound } from '../errors'
import { idParam, withWorkspaceLock } from '../guards'
const invalidInvite = () => new HttpError(404, 'invite_invalid', 'This invite link is not valid any more. Ask for a new one.')
const stillValid = () => and(isNull(invites.revokedAt), gt(invites.expiresAt, sql`now()`), gt(invites.usesLeft, 0))
export function inviteRoutes(ctx: AppContext) {
  const { db, sync, limiters } = ctx
  const authed = { preHandler: requireAuth(ctx) }
  return async (app: FastifyInstance) => {
    app.post('/api/workspaces/:id/invites', authed, async (request, reply) => {
      const { user } = me(request)
      const id = idParam((request.params as { id?: string }).id)
      const body = createInviteBody.parse(request.body)
      const token = newToken()
      const invite = await withWorkspaceLock(db, user.id, id, 'members:manage', async (tx) => {
        const [{ active }] = await tx.select({ active: count() }).from(invites).where(and(eq(invites.workspaceId, id), stillValid()))
        if (active >= LIMITS.maxActiveInvites) {
          throw new HttpError(403, 'quota_exceeded', `A workspace can have up to ${LIMITS.maxActiveInvites} active invite links. Revoke one first.`)
        }
        const [row] = await tx
          .insert(invites)
          .values({
            workspaceId: id,
            role: body.role,
            tokenHash: hashToken(token),
            createdBy: user.id,
            expiresAt: new Date(Date.now() + body.expiresInHours * 3_600_000),
            usesLeft: body.maxUses,
          })
          .returning()
        return row
      })
      const response: { invite: InviteDto; token: string } = { invite: toInviteDto(invite, user.displayName), token }
      return reply.code(201).send(response)
    })

    app.get('/api/workspaces/:id/invites', authed, async (request) => {
      const { user } = me(request)
      const id = idParam((request.params as { id?: string }).id)
      await withWorkspaceLock(db, user.id, id, 'members:manage', async () => undefined)
      const rows = await db
        .select({ invite: invites, createdByName: users.displayName })
        .from(invites)
        .leftJoin(users, eq(users.id, invites.createdBy))
        .where(and(eq(invites.workspaceId, id), stillValid()))
        .orderBy(asc(invites.createdAt), asc(invites.id))
      const list: InviteDto[] = rows.map((row) => toInviteDto(row.invite, row.createdByName))
      return { invites: list }
    })

    app.delete('/api/workspaces/:id/invites/:inviteId', authed, async (request, reply) => {
      const { user } = me(request)
      const params = request.params as { id?: string; inviteId?: string }
      const id = idParam(params.id)
      const inviteId = idParam(params.inviteId)
      await withWorkspaceLock(db, user.id, id, 'members:manage', async (tx) => {
        const revoked = await tx
          .update(invites)
          .set({ revokedAt: sql`now()` })
          .where(and(eq(invites.id, inviteId), eq(invites.workspaceId, id), isNull(invites.revokedAt)))
          .returning({ id: invites.id })
        if (revoked.length === 0) throw notFound('Invite not found')
      })
      return reply.code(204).send()
    })
    app.post('/api/invites/preview', async (request) => {
      take(limiters.invite, addressKey(request.ip))
      const { token } = inviteTokenBody.parse(request.body)
      const [row] = await db
        .select({ role: invites.role, workspaceName: workspaces.name, invitedBy: users.displayName })
        .from(invites)
        .innerJoin(workspaces, eq(workspaces.id, invites.workspaceId))
        .leftJoin(users, eq(users.id, invites.createdBy))
        .where(and(eq(invites.tokenHash, hashToken(token)), stillValid()))
      if (!row) throw invalidInvite()
      const preview: InvitePreview = { workspaceName: row.workspaceName, role: row.role, invitedBy: row.invitedBy }
      return preview
    })

    app.post('/api/invites/accept', authed, async (request) => {
      const { user } = me(request)
      take(limiters.invite, addressKey(request.ip))
      const { token } = inviteTokenBody.parse(request.body)
      const tokenHash = hashToken(token)
      const [found] = await db.select({ workspaceId: invites.workspaceId }).from(invites).where(and(eq(invites.tokenHash, tokenHash), stillValid()))
      if (!found) throw invalidInvite()
      const result = await db.transaction(async (tx) => {
        const [workspace] = await tx.select().from(workspaces).where(eq(workspaces.id, found.workspaceId)).for('update')
        if (!workspace) throw invalidInvite()
        const [invite] = await tx
          .select()
          .from(invites)
          .where(and(eq(invites.tokenHash, tokenHash), eq(invites.workspaceId, workspace.id), stillValid()))
          .for('update')
        if (!invite) throw invalidInvite()
        const [existing] = await tx
          .select({ role: memberships.role })
          .from(memberships)
          .where(and(eq(memberships.workspaceId, workspace.id), eq(memberships.userId, user.id)))
        if (existing) return { workspace: toWorkspaceDto(workspace, existing.role), joined: false }
        const [{ members }] = await tx.select({ members: count() }).from(memberships).where(eq(memberships.workspaceId, workspace.id))
        if (members >= LIMITS.maxMembersPerWorkspace) {
          throw new HttpError(409, 'workspace_full', `This workspace already has ${LIMITS.maxMembersPerWorkspace} members`)
        }
        await tx.insert(memberships).values({ workspaceId: workspace.id, userId: user.id, role: invite.role })
        await tx.update(invites).set({ usesLeft: sql`${invites.usesLeft} - 1` }).where(eq(invites.id, invite.id))
        return { workspace: toWorkspaceDto(workspace, invite.role), joined: true }
      })

      if (result.joined) {
        request.log.info({ user: user.id, workspace: result.workspace.id, role: result.workspace.role }, 'invite accepted')
        sync.notifyWorkspace(result.workspace.id, 'members')
      }
      const response: WorkspaceDto = result.workspace
      return response
    })
  }
}
