import type { Role } from '@conflux/shared'
export const ROLE_LABELS: Record<Role, string> = { owner: 'Owner', editor: 'Editor', viewer: 'Viewer' }
export const ROLE_HELP: Record<Role, string> = {
  owner: 'Can edit pages and manage members, invite links and settings.',
  editor: 'Can read and edit pages, and create or delete them.',
  viewer: 'Can read pages and see who is here. Cannot change anything.',
}

export function RoleBadge({ role }: { role: Role }) {
  return (
    <span className={`role role-${role}`} title={ROLE_HELP[role]}>
      {ROLE_LABELS[role]}
    </span>
  )
}
