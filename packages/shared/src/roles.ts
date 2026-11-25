export const ROLES = ['owner', 'editor', 'viewer'] as const
export type Role = (typeof ROLES)[number]

export const ACTIONS = [
  'workspace:read',
  'workspace:rename',
  'workspace:delete',
  'workspace:leave',
  'members:read',
  'members:manage',
  'page:read',
  'page:edit',
  'page:create',
  'page:move',
  'page:delete',
] as const
export type Action = (typeof ACTIONS)[number]

const EVERYONE: readonly Role[] = ['viewer', 'editor', 'owner']
const EDITORS: readonly Role[] = ['editor', 'owner']
const OWNERS: readonly Role[] = ['owner']

const ALLOWED: Record<Action, readonly Role[]> = {
  'workspace:read': EVERYONE,
  'workspace:leave': EVERYONE,
  'members:read': EVERYONE,
  'page:read': EVERYONE,
  'page:edit': EDITORS,
  'page:create': EDITORS,
  'page:move': EDITORS,
  'page:delete': EDITORS,
  'workspace:rename': OWNERS,
  'workspace:delete': OWNERS,
  'members:manage': OWNERS,
}

export function can(role: Role | null | undefined, action: Action): boolean {
  return role != null && ALLOWED[action].includes(role)
}

export function isRole(value: unknown): value is Role {
  return typeof value === 'string' && (ROLES as readonly string[]).includes(value)
}
