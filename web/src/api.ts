import type {
  ApiErrorBody,
  InviteDto,
  InvitePreview,
  MeResponse,
  MemberDto,
  PageDto,
  Role,
  SignupResponse,
  WorkspaceDto,
} from '@conflux/shared'

export class ApiError extends Error {
  readonly status: number
  readonly code: string
  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
  }
}

let onSessionEnded: (() => void) | null = null
export function setSessionEndedHandler(handler: (() => void) | null): void {
  onSessionEnded = handler
}

type Options = {
  anonymous?: boolean
}

async function request<T>(method: string, path: string, body?: unknown, options: Options = {}): Promise<T> {
  let response: Response
  try {
    response = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    })
  } 
  catch {
    throw new ApiError(0, 'network', 'Cannot reach the server. Check your connection and try again.')
  }

  if (response.status === 204) return undefined as T
  let data: unknown = null
  try {
    data = await response.json()
  } catch {
    // Not JSON (for example a proxy error page). Handled below.
  }

  if (!response.ok) {
    const error = (data as ApiErrorBody | null)?.error
    if (response.status === 401 && !options.anonymous) onSessionEnded?.()
    throw new ApiError(
      response.status,
      error?.code ?? (response.status >= 500 ? 'server_error' : 'unknown'),
      error?.message ?? `Something went wrong (${response.status}). Please try again.`,
    )
  }
  return data as T
}

const enc = encodeURIComponent

export const api = {
  signup: (input: { email: string; password: string; displayName: string }) =>
    request<SignupResponse>('POST', '/api/auth/signup', input, { anonymous: true }),
  login: (input: { email: string; password: string }) => request<MeResponse>('POST', '/api/auth/login', input, { anonymous: true }),
  logout: () => request<void>('POST', '/api/auth/logout', undefined, { anonymous: true }),
  me: () => request<MeResponse>('GET', '/api/auth/me', undefined, { anonymous: true }),
  updateMe: (displayName: string) => request<MeResponse>('PATCH', '/api/auth/me', { displayName }),

  createWorkspace: (name: string) => request<WorkspaceDto>('POST', '/api/workspaces', { name }),
  renameWorkspace: (id: string, name: string) => request<WorkspaceDto>('PATCH', `/api/workspaces/${enc(id)}`, { name }),
  deleteWorkspace: (id: string) => request<void>('DELETE', `/api/workspaces/${enc(id)}`),
  members: (id: string) => request<{ members: MemberDto[] }>('GET', `/api/workspaces/${enc(id)}/members`),
  setRole: (id: string, userId: string, role: Role) =>
    request<{ ok: true }>('PATCH', `/api/workspaces/${enc(id)}/members/${enc(userId)}`, { role }),
  removeMember: (id: string, userId: string) => request<void>('DELETE', `/api/workspaces/${enc(id)}/members/${enc(userId)}`),

  createInvite: (id: string, input: { role: 'editor' | 'viewer'; expiresInHours: number; maxUses: number }) =>
    request<{ invite: InviteDto; token: string }>('POST', `/api/workspaces/${enc(id)}/invites`, input),
  invites: (id: string) => request<{ invites: InviteDto[] }>('GET', `/api/workspaces/${enc(id)}/invites`),
  revokeInvite: (id: string, inviteId: string) => request<void>('DELETE', `/api/workspaces/${enc(id)}/invites/${enc(inviteId)}`),
  previewInvite: (token: string) => request<InvitePreview>('POST', '/api/invites/preview', { token }, { anonymous: true }),
  acceptInvite: (token: string) => request<WorkspaceDto>('POST', '/api/invites/accept', { token }),

  pages: (workspaceId: string) => request<{ pages: PageDto[] }>('GET', `/api/workspaces/${enc(workspaceId)}/pages`),
  createPage: (workspaceId: string, title: string) => request<PageDto>('POST', `/api/workspaces/${enc(workspaceId)}/pages`, { title }),
  renamePage: (id: string, title: string) => request<PageDto>('PATCH', `/api/pages/${enc(id)}`, { title }),
  deletePage: (id: string) => request<void>('DELETE', `/api/pages/${enc(id)}`),

  syncToken: (doc: string) => request<{ token: string; expiresAt: string }>('POST', '/api/sync-token', { doc }),
}
