import { can, uuidSchema, type Action, type Role } from '@conflux/shared'
import { eq } from 'drizzle-orm'
import { workspaceRole } from '../access'
import type { Db, Tx } from '../db/client'
import { workspaces } from '../db/schema'
import { forbidden, notFound } from './errors'

export function idParam(value: unknown): string {
  const parsed = uuidSchema.safeParse(value)
  if (!parsed.success) throw notFound()
  return parsed.data
}

export async function authorizeWorkspace(db: Db | Tx, userId: string, workspaceId: string, action: Action): Promise<Role> {
  const role = await workspaceRole(db, userId, workspaceId)
  if (!role) throw notFound('Workspace not found')
  if (!can(role, action)) throw forbidden()
  return role
}

export async function withWorkspaceLock<T>(
  db: Db,
  userId: string,
  workspaceId: string,
  action: Action,
  work: (tx: Tx, role: Role) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    const locked = await tx.select({ id: workspaces.id }).from(workspaces).where(eq(workspaces.id, workspaceId)).for('update')
    if (locked.length === 0) throw notFound('Workspace not found')
    const role = await authorizeWorkspace(tx, userId, workspaceId, action)
    return work(tx, role)
  })
}
