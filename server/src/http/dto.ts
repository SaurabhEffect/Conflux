import type { InviteDto, MemberDto, PageDto, Role, UserDto, WorkspaceDto } from '@conflux/shared'
import type { SessionUser } from '../auth/sessions'
import type { invites, pages, workspaces } from '../db/schema'

export const toUserDto = (user: SessionUser): UserDto => ({
  id: user.id,
  email: user.email,
  displayName: user.displayName,
  cursorColor: user.cursorColor,
})

export const toWorkspaceDto = (workspace: typeof workspaces.$inferSelect, role: Role): WorkspaceDto => ({
  id: workspace.id,
  name: workspace.name,
  role,
  createdAt: workspace.createdAt.toISOString(),
})

export const toPageDto = (page: typeof pages.$inferSelect): PageDto => ({
  id: page.id,
  workspaceId: page.workspaceId,
  title: page.title,
  position: page.position,
  createdAt: page.createdAt.toISOString(),
  updatedAt: page.updatedAt.toISOString(),
})

export const toInviteDto = (invite: typeof invites.$inferSelect, createdByName: string | null): InviteDto => ({
  id: invite.id,
  role: invite.role,
  createdAt: invite.createdAt.toISOString(),
  expiresAt: invite.expiresAt.toISOString(),
  usesLeft: invite.usesLeft,
  createdByName,
})

export type MemberRow = { userId: string; displayName: string; cursorColor: string; email: string; role: Role; joinedAt: Date }

export const toMemberDto = (row: MemberRow, includeEmail: boolean): MemberDto => ({
  userId: row.userId,
  displayName: row.displayName,
  cursorColor: row.cursorColor,
  role: row.role,
  joinedAt: row.joinedAt.toISOString(),
  ...(includeEmail ? { email: row.email } : {}),
})
