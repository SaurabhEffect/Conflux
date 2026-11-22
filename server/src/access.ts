import { and, eq, isNull } from 'drizzle-orm'
import { parseDocName, type Role } from '@conflux/shared'
import type { Db, Tx } from './db/client'
import { memberships, pages } from './db/schema'

export type PageRow = typeof pages.$inferSelect
export async function workspaceRole(db: Db | Tx, userId: string, workspaceId: string): Promise<Role | null> {
  const [row] = await db
    .select({ role: memberships.role })
    .from(memberships)
    .where(and(eq(memberships.workspaceId, workspaceId), eq(memberships.userId, userId)))
  return row?.role ?? null
}

export async function pageAccess(db: Db | Tx, userId: string, pageId: string): Promise<{ page: PageRow; role: Role } | null> {
  const [row] = await db
    .select({ page: pages, role: memberships.role })
    .from(pages)
    .innerJoin(memberships, and(eq(memberships.workspaceId, pages.workspaceId), eq(memberships.userId, userId)))
    .where(and(eq(pages.id, pageId), isNull(pages.deletedAt)))
  return row ?? null
}

export type DocAccess = { kind: 'page' | 'workspace'; workspaceId: string; pageId: string | null; role: Role }

export async function docAccess(db: Db | Tx, userId: string, docName: string): Promise<DocAccess | null> {
  const ref = parseDocName(docName)
  if (!ref) return null
  if (ref.kind === 'workspace') {
    const role = await workspaceRole(db, userId, ref.id)
    return role ? { kind: 'workspace', workspaceId: ref.id, pageId: null, role } : null
  }
  const access = await pageAccess(db, userId, ref.id)
  return access ? { kind: 'page', workspaceId: access.page.workspaceId, pageId: ref.id, role: access.role } : null
}
