import { can, pageDocName, type PageDto, type Role } from '@conflux/shared'
import { useEffect, useRef, useState, type RefObject } from 'react'
import { useSession } from '../auth'
import { useCollabDoc } from '../collab/useCollabDoc'
import { usePeers } from '../collab/usePeers'
import { justCreated } from '../session'
import { Icon } from './Icons'
import { PageEditor } from './PageEditor'
import { Avatars, StatusPill } from './Presence'
import { RoleBadge } from './RoleBadge'
import { MenuButton, NotFound, Splash } from './Shell'

type Props = {
  page: PageDto
  role: Role
  onRename: (title: string) => void
  onDelete: () => void
  onOpenMenu: () => void
  onHome: () => void
}

export function PageView({ page, role, onRename, onDelete, onOpenMenu, onHome }: Props) {
  const { user } = useSession()
  const collab = useCollabDoc(pageDocName(page.id), { workspaceId: page.workspaceId })
  const peers = usePeers(collab?.provider ?? null)
  const titleRef = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (justCreated.delete(page.id)) titleRef.current?.focus()
  }, [page.id])

  const mayEdit = can(role, 'page:edit') && collab?.scope !== 'readonly'

  if (collab?.noAccess) return <NotFound onHome={onHome} onOpenMenu={onOpenMenu} />

  return (
    <section className="page">
      <header className="page-header">
        <MenuButton onClick={onOpenMenu} />
        <TitleInput value={page.title} onChange={onRename} inputRef={titleRef} readOnly={!mayEdit} />
        {!mayEdit && <RoleBadge role={role} />}
        <Avatars peers={peers} />
        <span className="only-mobile">
          <StatusPill status={collab?.status ?? 'connecting'} compact />
        </span>
        {can(role, 'page:delete') && (
          <button type="button" className="icon-btn" aria-label="Delete page" title="Delete page" onClick={onDelete}>
            <Icon name="trash" size={18} />
          </button>
        )}
      </header>
      {!mayEdit && (
        <p className="banner" role="note">
          <Icon name="eye" size={16} />
          You can read this page, but not change it. Ask an owner for editor access.
        </p>
      )}
      {collab?.ready ? (
        <PageEditor
          pageId={page.id}
          doc={collab.doc}
          provider={collab.provider}
          user={{ name: user.displayName, color: user.cursorColor }}
          editable={mayEdit}
        />
      ) : (
        <Splash />
      )}
    </section>
  )
}

function TitleInput({
  value,
  onChange,
  inputRef,
  readOnly,
}: {
  value: string
  onChange: (title: string) => void
  inputRef: RefObject<HTMLInputElement | null>
  readOnly: boolean
}) {
  const [draft, setDraft] = useState(value)
  const typing = useRef(false)
  useEffect(() => {
    if (!typing.current) setDraft(value)
  }, [value])
  return (
    <input
      ref={inputRef}
      className="title-input"
      value={draft}
      placeholder="Untitled"
      aria-label="Page title"
      maxLength={120}
      readOnly={readOnly}
      onFocus={() => {
        typing.current = true
      }}
      onBlur={() => {
        typing.current = false
        setDraft(value)
      }}
      onChange={(event) => {
        setDraft(event.target.value)
        onChange(event.target.value)
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault()
          document.querySelector<HTMLElement>('.doc')?.focus() // jump into the text
        }
      }}
    />
  )
}
