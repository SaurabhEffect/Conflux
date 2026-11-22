import { cursorColorFor, loginBody, signupBody, updateMeBody, type MeResponse, type SignupResponse } from '@conflux/shared'
import { asc, eq, sql } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { hashPassword, verifyAgainstDummy, verifyPassword } from '../../auth/password'
import { createSession, deleteSessionByToken } from '../../auth/sessions'
import { isUniqueViolation } from '../../db/client'
import { addressKey } from '../../util/address'
import { memberships, pages, users, workspaces } from '../../db/schema'
import { clearSessionCookie, me, requireAuth, sessionCookieName, setSessionCookie, take, takeHash, type AppContext } from '../context'
import { toUserDto, toWorkspaceDto } from '../dto'
import { HttpError } from '../errors'

export function authRoutes(ctx: AppContext) {
  const { db, config, sync, limiters } = ctx
  const authed = { preHandler: requireAuth(ctx) }
  async function listWorkspaces(userId: string) {
    const rows = await db
      .select({ workspace: workspaces, role: memberships.role })
      .from(memberships)
      .innerJoin(workspaces, eq(workspaces.id, memberships.workspaceId))
      .where(eq(memberships.userId, userId))
      .orderBy(asc(memberships.createdAt), asc(workspaces.id))
    return rows.map((row) => toWorkspaceDto(row.workspace, row.role))
  }

  async function startSession(request: { cookies: Record<string, string | undefined> }, reply: Parameters<typeof setSessionCookie>[0], userId: string) {
    const previous = request.cookies[sessionCookieName(config)]
    if (previous) await deleteSessionByToken(db, previous)
    const session = await createSession(db, userId, config.sessionDays)
    setSessionCookie(reply, config, session.token, session.expiresAt)
  }

  return async (app: FastifyInstance) => {
    app.post('/api/auth/signup', async (request, reply) => {
      take(limiters.signup, addressKey(request.ip))
      const body = signupBody.parse(request.body)
      takeHash(ctx)
      const passwordHash = await hashPassword(body.password)

      let created
      try {
        created = await db.transaction(async (tx) => {
          const [user] = await tx
            .insert(users)
            .values({ email: body.email, passwordHash, displayName: body.displayName, cursorColor: cursorColorFor(body.email) })
            .returning()
          const [workspace] = await tx
            .insert(workspaces)
            .values({ name: `${body.displayName}'s workspace`, createdBy: user.id })
            .returning()
          await tx.insert(memberships).values({ workspaceId: workspace.id, userId: user.id, role: 'owner' })
          const [welcome] = await tx
            .insert(pages)
            .values({ workspaceId: workspace.id, title: 'Welcome to Conflux', position: 0, createdBy: user.id })
            .returning({ id: pages.id })
          return { user, workspace, welcomePageId: welcome.id }
        })
      } catch (error) {
        if (isUniqueViolation(error)) throw new HttpError(409, 'email_taken', 'An account with this email already exists. Try signing in.')
        throw error
      }

      await startSession(request, reply, created.user.id)
      request.log.info({ user: created.user.id }, 'account created')
      const response: SignupResponse = {
        user: toUserDto(created.user),
        workspaces: [toWorkspaceDto(created.workspace, 'owner')],
        welcomePageId: created.welcomePageId,
      }
      return reply.code(201).send(response)
    })

    app.post('/api/auth/login', async (request, reply) => {
      const address = addressKey(request.ip)
      take(limiters.login, address)
      const body = loginBody.parse(request.body)
      take(limiters.loginPerAccount, `${address}|${body.email}`)
      takeHash(ctx)

      const [user] = await db.select().from(users).where(eq(sql`lower(${users.email})`, body.email))
      let ok = false
      if (user) ok = await verifyPassword(user.passwordHash, body.password)
      else await verifyAgainstDummy(body.password)
      if (!user || !ok) {
        request.log.info({ email: body.email.replace(/^(.).*(@.*)$/, '$1***$2') }, 'sign-in failed')
        throw new HttpError(401, 'invalid_credentials', 'Wrong email or password')
      }

      await startSession(request, reply, user.id)
      request.log.info({ user: user.id }, 'signed in')
      const response: MeResponse = { user: toUserDto(user), workspaces: await listWorkspaces(user.id) }
      return response
    })

    app.post('/api/auth/logout', async (request, reply) => {
      const token = request.cookies[sessionCookieName(config)]
      if (token) await deleteSessionByToken(db, token)
      clearSessionCookie(reply, config)
      await sync.sweepNow()
      return reply.code(204).send()
    })

    app.get('/api/auth/me', authed, async (request) => {
      const { user } = me(request)
      const response: MeResponse = { user: toUserDto(user), workspaces: await listWorkspaces(user.id) }
      return response
    })

    app.patch('/api/auth/me', authed, async (request) => {
      const { user } = me(request)
      const body = updateMeBody.parse(request.body)
      const [updated] = await db.update(users).set({ displayName: body.displayName }).where(eq(users.id, user.id)).returning()
      for (const workspace of await listWorkspaces(user.id)) sync.notifyWorkspace(workspace.id, 'members')
      const response: MeResponse = { user: toUserDto(updated), workspaces: await listWorkspaces(user.id) }
      return response
    })
  }
}
