import type { WorkspaceDto } from '@conflux/shared'
import { useCallback, useRef, useState } from 'react'
import { Icon } from './Icons'
import { RoleBadge } from './RoleBadge'
import { useDismiss } from './useDismiss'

type Props = {
  current: WorkspaceDto
  all: WorkspaceDto[]
  onSwitch: (id: string) => void
  onCreate: () => void
}

export function WorkspaceSwitcher({ current, all, onSwitch, onCreate }: Props) {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const close = useCallback(() => setOpen(false), [])
  useDismiss(open, root, close)

  return (
    <div className="switcher" ref={root}>
      <button
        type="button"
        className="switcher-btn"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Workspace: ${current.name}. Switch workspace`}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="switcher-name">{current.name}</span>
        <Icon name="chevronDown" size={16} />
      </button>
      {open && (
        <div className="menu" role="menu" aria-label="Your workspaces">
          {all.map((workspace) => (
            <button
              key={workspace.id}
              type="button"
              role="menuitemradio"
              aria-checked={workspace.id === current.id}
              className="menu-item"
              onClick={() => {
                close()
                if (workspace.id !== current.id) onSwitch(workspace.id)
              }}
            >
              <span className="menu-check">{workspace.id === current.id && <Icon name="check" size={15} />}</span>
              <span className="menu-label">{workspace.name}</span>
              <RoleBadge role={workspace.role} />
            </button>
          ))}
          <div className="menu-sep" role="separator" />
          <button
            type="button"
            role="menuitem"
            className="menu-item"
            onClick={() => {
              close()
              onCreate()
            }}
          >
            <span className="menu-check">
              <Icon name="plus" size={15} />
            </span>
            <span className="menu-label">New workspace…</span>
          </button>
        </div>
      )}
    </div>
  )
}
