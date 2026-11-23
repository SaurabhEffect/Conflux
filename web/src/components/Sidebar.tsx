import { can, type PageDto, type WorkspaceDto } from '@conflux/shared'
import type { ConnectionStatus } from '../collab/useCollabDoc'
import { hrefFor } from '../route'
import { AccountMenu } from './AccountMenu'
import { Icon } from './Icons'
import { LogoMark } from './Logo'
import { StatusPill } from './Presence'
import { RoleBadge } from './RoleBadge'
import { WorkspaceSwitcher } from './WorkspaceSwitcher'

type Props = {
  workspace: WorkspaceDto
  workspaces: WorkspaceDto[]
  pages: PageDto[] | null
  activeId: string | null
  status: ConnectionStatus
  open: boolean
  onNewPage: () => void
  onDeletePage: (page: PageDto) => void
  onNavigate: () => void
  onOpenMembers: () => void
  onSwitchWorkspace: (id: string) => void
  onNewWorkspace: () => void
}

export function Sidebar(props: Props) {
  const { workspace, workspaces, pages, activeId, status, open } = props
  const mayCreate = can(workspace.role, 'page:create')
  const mayDelete = can(workspace.role, 'page:delete')

  return (
    <aside className="sidebar" data-open={open} aria-label="Workspace">
      <div className="brand">
        <LogoMark size={40} />
        <span className="brand-name">Conflux</span>
      </div>

      <WorkspaceSwitcher current={workspace} all={workspaces} onSwitch={props.onSwitchWorkspace} onCreate={props.onNewWorkspace} />

      {mayCreate && (
        <button type="button" className="btn-new" onClick={props.onNewPage}>
          <Icon name="plus" size={16} />
          New page
        </button>
      )}

      <nav className="page-list" aria-label="Pages">
        <div className="section-label">Pages</div>
        {pages === null && <p className="empty-hint">Loading…</p>}
        {pages?.length === 0 && <p className="empty-hint">No pages yet.</p>}
        <ul>
          {pages?.map((page) => {
            const title = page.title || 'Untitled'
            const active = page.id === activeId
            return (
              <li key={page.id} className={active ? 'active' : undefined}>
                <a
                  href={hrefFor({ name: 'page', workspaceId: workspace.id, pageId: page.id })}
                  aria-current={active ? 'page' : undefined}
                  onClick={props.onNavigate}
                >
                  <Icon name="doc" size={16} />
                  <span className="page-title">{title}</span>
                </a>
                {mayDelete && (
                  <button
                    type="button"
                    className="icon-btn row-action"
                    aria-label={`Delete ${title}`}
                    title="Delete page"
                    onClick={() => props.onDeletePage(page)}
                  >
                    <Icon name="trash" size={15} />
                  </button>
                )}
              </li>
            )
          })}
        </ul>
      </nav>

      <div className="sidebar-foot">
        <button type="button" className="btn-members" onClick={props.onOpenMembers}>
          <Icon name="users" size={16} />
          <span>Members</span>
          <RoleBadge role={workspace.role} />
        </button>
        <StatusPill status={status} />
        <AccountMenu />
      </div>
    </aside>
  )
}
