import { useEffect, useRef, useState, type RefObject } from 'react'
import { useCollabDoc } from '../collab/useCollabDoc'
import { usePeers } from '../collab/usePeers'
import type { PageMeta } from '../collab/useWorkspace'
import type { Identity } from '../identity'
import { justCreated } from '../session'
import { Icon } from './Icons'
import { PageEditor } from './PageEditor'
import { Avatars, StatusPill } from './Presence'
import { MenuButton, Splash } from './Shell'

type Props = {
  page: PageMeta
  identity: Identity
  onRename: (title: string) => void
  onDelete: () => void
  onOpenMenu: () => void
}

export function PageView({ page, identity, onRename, onDelete, onOpenMenu }: Props) {
  const collab = useCollabDoc(`page:${page.id}`, identity)
  const peers = usePeers(collab?.provider ?? null)
  const titleRef = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (justCreated.delete(page.id)) titleRef.current?.focus()
  }, [page.id])

  return (
    <section className="page">
      <header className="page-header">
        <MenuButton onClick={onOpenMenu} />
        <TitleInput value={page.title} onChange={onRename} inputRef={titleRef} />
        <Avatars peers={peers} />
        <span className="only-mobile">
          <StatusPill status={collab?.status ?? 'connecting'} compact />
        </span>
        <button type="button" className="icon-btn" aria-label="Delete page" title="Delete page" onClick={onDelete}>
          <Icon name="trash" size={18} />
        </button>
      </header>
      {collab?.ready ? (
        <PageEditor pageId={page.id} doc={collab.doc} provider={collab.provider} user={identity} />
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
}: {
  value: string
  onChange: (title: string) => void
  inputRef: RefObject<HTMLInputElement | null>
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
