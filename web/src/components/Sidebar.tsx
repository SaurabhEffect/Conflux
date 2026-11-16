import { useState, type FormEvent } from 'react'
import type { ConnectionStatus } from '../collab/useCollabDoc'
import type { PageMeta } from '../collab/useWorkspace'
import { changeName, initialOf, type Identity } from '../identity'
import { Icon } from './Icons'
import { LogoMark } from './Logo'
import { StatusPill } from './Presence'

type Props = {
  pages: PageMeta[]
  activeId: string | null
  me: Identity
  status: ConnectionStatus
  open: boolean
  onNewPage: () => void
  onDeletePage: (page: PageMeta) => void
  onNavigate: () => void
}

export function Sidebar({ pages, activeId, me, status, open, onNewPage, onDeletePage, onNavigate }: Props) {
  return (
    <aside className="sidebar" data-open={open} aria-label="Workspace">
      <div className="brand">
        <LogoMark size={40} />
        <span className="brand-name">Conflux</span>
      </div>

      <button type="button" className="btn-new" onClick={onNewPage}>
        <Icon name="plus" size={16} />
        New page
      </button>

      <nav className="page-list" aria-label="Pages">
        <div className="section-label">Pages</div>
        {pages.length === 0 && <p className="empty-hint">No pages yet.</p>}
        <ul>
          {pages.map((page) => {
            const title = page.title || 'Untitled'
            const active = page.id === activeId
            return (
              <li key={page.id} className={active ? 'active' : undefined}>
                <a href={`#/p/${page.id}`} aria-current={active ? 'page' : undefined} onClick={onNavigate}>
                  <Icon name="doc" size={16} />
                  <span className="page-title">{title}</span>
                </a>
                <button
                  type="button"
                  className="icon-btn row-action"
                  aria-label={`Delete ${title}`}
                  title="Delete page"
                  onClick={() => onDeletePage(page)}
                >
                  <Icon name="trash" size={15} />
                </button>
              </li>
            )
          })}
        </ul>
      </nav>

      <div className="sidebar-foot">
        <StatusPill status={status} />
        <YouChip me={me} />
      </div>
    </aside>
  )
}

function YouChip({ me }: { me: Identity }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(me.name)
  const submit = (event: FormEvent) => {
    event.preventDefault()
    changeName(draft)
  }
  if (editing) {
    return (
      <form className="you you-edit" onSubmit={submit}>
        <input
          value={draft}
          maxLength={24}
          autoFocus
          aria-label="Your name"
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => event.key === 'Escape' && setEditing(false)}
        />
        <button type="submit" className="link-btn">
          Save
        </button>
      </form>
    )
  }

  return (
    <div className="you">
      <span className="avatar" style={{ background: me.color }} aria-hidden="true">
        {initialOf(me.name)}
      </span>
      <span className="you-name" title={me.name}>
        {me.name}
      </span>
      <button type="button" className="link-btn" onClick={() => setEditing(true)}>
        Change
      </button>
    </div>
  )
}
