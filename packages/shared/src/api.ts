import type { Role } from './roles'

export type UserDto = {
  id: string
  email: string
  displayName: string
  cursorColor: string
}

export type WorkspaceDto = {
  id: string
  name: string
  role: Role
  createdAt: string
}

export type MemberDto = {
  userId: string
  displayName: string
  cursorColor: string
  role: Role
  joinedAt: string
  email?: string
}

export type InviteDto = {
  id: string
  role: Role
  createdAt: string
  expiresAt: string
  usesLeft: number
  createdByName: string | null
}

export type PageDto = {
  id: string
  workspaceId: string
  title: string
  position: number
  createdAt: string
  updatedAt: string
}

export type MeResponse = { user: UserDto; workspaces: WorkspaceDto[] }
export type SignupResponse = MeResponse & { welcomePageId: string }
export type InvitePreview = { workspaceName: string; role: Role; invitedBy: string | null }

export type ApiErrorBody = {
  error: {
    code: string
    message: string
    issues?: { path: string; message: string }[]
  }
}

export type WorkspaceEvent = { type: 'pages' | 'members' | 'workspace' }

export const CLOSE_CODES = {
  unauthorized: 4401,
  forbidden: 4403,
  tooManyConnections: 4429,
  roleChanged: 4430,
} as const

export const CLOSE_REASONS = {
  sessionEnded: 'session-ended',
  accessRevoked: 'access-revoked',
  roleChanged: 'role-changed',
  tooManyConnections: 'too-many-connections',
} as const
