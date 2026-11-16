import { useEffect, useState } from 'react'
import { useWorkspace, type PageMeta } from './collab/useWorkspace'
import { PageView } from './components/PageView'
import { EmptyState, NotFound, Splash } from './components/Shell'
import { Sidebar } from './components/Sidebar'
import { Welcome } from './components/Welcome'
import { chooseFirstName, loadIdentity, type Identity } from './identity'
import { useHashRoute } from './route'
import { welcomeHtml } from './seeds'
import { justCreated, pendingSeeds } from './session'

export default function App() {
  const [identity, setIdentity] = useState<Identity | null>(loadIdentity)
  if (!identity) return <Welcome onDone={(name) => setIdentity(chooseFirstName(name))} />
  return <Workspace identity={identity} />
}

function Workspace({ identity }: { identity: Identity }) {
  const workspace = useWorkspace(identity)
  const { pageId, go } = useHashRoute()
  const [sidebarOpen, setSidebarOpen] = useState(false) // only matters on small screens
  const { ready, pages } = workspace
  const page = pages.find((p) => p.id === pageId) ?? null
  useEffect(() => {
    if (ready && !pageId && pages.length > 0) go(pages[0].id, { replace: true })
  }, [ready, pageId, pages, go])
  const pageTitle = page ? page.title || 'Untitled' : null
  useEffect(() => {
    document.title = pageTitle ? `${pageTitle} · Conflux` : 'Conflux'
  }, [pageTitle])
  const newPage = () => {
    const id = workspace.createPage('')
    justCreated.add(id)
    go(id)
    setSidebarOpen(false)
  }

  const firstPage = () => {
    const id = workspace.createPage('Welcome to Conflux')
    pendingSeeds.set(id, welcomeHtml)
    go(id)
  }

  const removePage = (target: PageMeta) => {
    const name = target.title || 'Untitled'
    if (!window.confirm(`Delete "${name}" for everyone? This cannot be undone.`)) return
    const index = pages.findIndex((p) => p.id === target.id)
    workspace.deletePage(target.id)
    if (target.id === pageId) {
      const next = pages[index + 1] ?? pages[index - 1]
      go(next?.id ?? null, { replace: true })
    }
  }
  const openMenu = () => setSidebarOpen(true)
  let content
  if (!ready) content = <Splash />
  else if (pages.length === 0) content = <EmptyState onCreate={firstPage} onOpenMenu={openMenu} />
  else if (!pageId) content = <Splash /> // the redirect above is about to run
  else if (!page) content = <NotFound onHome={() => go(pages[0].id)} onOpenMenu={openMenu} />
  else {
    content = (
      <PageView
        key={page.id}
        page={page}
        identity={identity}
        onRename={(title) => workspace.renamePage(page.id, title)}
        onDelete={() => removePage(page)}
        onOpenMenu={openMenu}
      />
    )
  }

  return (
    <div className="app" data-sidebar={sidebarOpen ? 'open' : 'closed'}>
      <Sidebar
        pages={pages}
        activeId={pageId}
        me={identity}
        status={workspace.status}
        open={sidebarOpen}
        onNewPage={newPage}
        onDeletePage={removePage}
        onNavigate={() => setSidebarOpen(false)}
      />
      <div className="backdrop" onClick={() => setSidebarOpen(false)} aria-hidden="true" />
      <main className="main">{content}</main>
    </div>
  )
}
