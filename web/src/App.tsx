import { can, type PageDto, type WorkspaceDto } from '@conflux/shared'
import { useCallback, useEffect, useState } from 'react'
import { AuthProvider, useAuth, useSession } from './auth'
import { AuthScreen } from './components/AuthScreen'
import { CreateWorkspaceDialog } from './components/CreateWorkspaceDialog'
import { DemoScreen } from './components/DemoScreen'
import { InviteScreen } from './components/InviteScreen'
import { LogoMark } from './components/Logo'
import { MembersDialog } from './components/MembersDialog'
import { PageView } from './components/PageView'
import { EmptyState, ErrorBoundary, FullScreenMessage, NotFound, Splash } from './components/Shell'
import { Sidebar } from './components/Sidebar'
import { forgetWorkspaceCopies } from './collab/localStore'
import { usePages } from './collab/usePages'
import { useWorkspaceChannel, type ChannelEvent } from './collab/useWorkspaceChannel'
import { useRoute } from './route'
import { justCreated } from './session'
import { ToastProvider, useToast } from './toast'
import { readSetting, writeSetting } from './util'

export default function App() {
  return (
    <ErrorBoundary>
      <ToastProvider>
        <AuthProvider>
          <Gate />
        </AuthProvider>
      </ToastProvider>
    </ErrorBoundary>
  )
}

function Gate() {
  const { state, retry } = useAuth()
  const { route } = useRoute()
  if (route.name === 'join') return <InviteScreen token={route.token} />
  if (route.name === 'demo') return <DemoScreen ticket={route.ticket} pageId={route.pageId} />
  switch (state.status) {
    case 'loading':
      return <Loading />
    case 'unreachable':
      return <FullScreenMessage title="Cannot reach Conflux" text={state.message} action="Try again" onAction={retry} />
    case 'signedOut':
      return <AuthScreen />
    case 'signedIn':
      return <Workspace />
  }
}

function Loading() {
  return (
    <main className="welcome">
      <LogoMark size={120} />
      <p className="muted" role="status">
        Loading…
      </p>
    </main>
  )
}

const lastWorkspaceKey = (userId: string) => `conflux.last-workspace.${userId}`

function Workspace() {
  const { user, workspaces, refresh, addWorkspace, logout } = useSession()
  const { route, go } = useRoute()
  const toast = useToast()
  const [creating, setCreating] = useState(false)
  const [leaving, setLeaving] = useState<string | null>(null)
  const [lost, setLost] = useState<{ id: string; name: string } | null>(null)

  useEffect(() => {
    if (leaving && !workspaces.some((workspace) => workspace.id === leaving)) setLeaving(null)
  }, [workspaces, leaving])

  const choices = workspaces.filter((workspace) => workspace.id !== leaving)
  const remembered = readSetting(lastWorkspaceKey(user.id))
  const fallback = choices.find((workspace) => workspace.id === remembered) ?? choices[0] ?? null
  const fallbackId = fallback?.id ?? null

  useEffect(() => {
    if (route.name === 'home' && fallbackId) go({ name: 'workspace', workspaceId: fallbackId }, { replace: true })
  }, [route.name, fallbackId, go])

  const goHome = useCallback(() => {
    setLost(null)
    go({ name: 'home' }, { replace: true })
  }, [go])

  if (route.name === 'home' || route.name === 'join' || route.name === 'demo') {
    if (choices.length > 0) return <Loading />
    return (
      <>
        <FullScreenMessage
          title="You are not in any workspace"
          text="Create one of your own, or open an invite link that someone sent you."
          action="Create a workspace"
          onAction={() => setCreating(true)}
          secondary="Sign out"
          onSecondary={() => void logout().catch((error: Error) => toast(error.message, 'error'))}
        />
        {creating && (
          <CreateWorkspaceDialog
            onClose={() => setCreating(false)}
            onCreated={(workspace) => {
              addWorkspace(workspace)
              setCreating(false)
              go({ name: 'workspace', workspaceId: workspace.id })
            }}
          />
        )}
      </>
    )
  }

  if (lost && route.workspaceId === lost.id) {
    return (
      <FullScreenMessage
        title={`You no longer have access to ${lost.name}`}
        text="An owner removed you, or the workspace was deleted."
        action="Go to my workspaces"
        onAction={goHome}
      />
    )
  }
  if (route.workspaceId === leaving) return <Loading />

  const workspace = choices.find((item) => item.id === route.workspaceId)
  if (!workspace) {
    return (
      <FullScreenMessage
        title="Workspace not found"
        text="It does not exist, or you are not a member of it."
        action="Go to my workspaces"
        onAction={goHome}
      />
    )
  }

  return (
    <WorkspaceView
      key={workspace.id}
      workspace={workspace}
      workspaces={choices}
      pageId={route.name === 'page' ? route.pageId : null}
      onLost={() => {
        setLost({ id: workspace.id, name: workspace.name })
        void forgetWorkspaceCopies(user.id, workspace.id)
        void refresh()
      }}
      onLeft={() => {
        setLeaving(workspace.id)
        go({ name: 'home' }, { replace: true })
        void forgetWorkspaceCopies(user.id, workspace.id)
        void refresh()
      }}
    />
  )
}

type ViewProps = {
  workspace: WorkspaceDto
  workspaces: WorkspaceDto[]
  pageId: string | null
  onLost: () => void
  onLeft: () => void
}

function WorkspaceView({ workspace, workspaces, pageId, onLost, onLeft }: ViewProps) {
  const { user, refresh, addWorkspace } = useSession()
  const { go } = useRoute()
  const toast = useToast()
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [membersOpen, setMembersOpen] = useState(false)
  const [creatingWorkspace, setCreatingWorkspace] = useState(false)
  const [membersVersion, setMembersVersion] = useState(0)

  const pages = usePages(workspace.id, { onError: (message) => toast(message, 'error') })
  const reloadPages = pages.reload

  const onEvent = useCallback(
    (event: ChannelEvent) => {
      if (event === 'pages') reloadPages()
      else if (event === 'members') {
        void refresh() // our own role may have changed
        setMembersVersion((version) => version + 1)
      } else if (event === 'workspace') void refresh()
      else {
        // (Re)connected: we may have missed something while away.
        reloadPages()
        void refresh()
      }
    },
    [reloadPages, refresh],
  )
  const channel = useWorkspaceChannel(workspace.id, onEvent)

  useEffect(() => {
    writeSetting(`conflux.last-workspace.${user.id}`, workspace.id)
  }, [user.id, workspace.id])

  useEffect(() => {
    if (channel.noAccess) onLost()
  }, [channel.noAccess, onLost])

  const list = pages.pages
  const firstPageId = list?.[0]?.id ?? null
  useEffect(() => {
    if (!pageId && firstPageId) go({ name: 'page', workspaceId: workspace.id, pageId: firstPageId }, { replace: true })
  }, [pageId, firstPageId, workspace.id, go])

  const openPage = (id: string) => go({ name: 'page', workspaceId: workspace.id, pageId: id })
  const goHome = () => go({ name: 'workspace', workspaceId: workspace.id }, { replace: true })

  async function newPage() {
    try {
      const page = await pages.create('')
      justCreated.add(page.id)
      setSidebarOpen(false)
      openPage(page.id)
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Could not create the page.', 'error')
    }
  }

  async function deletePage(page: PageDto) {
    if (!window.confirm(`Delete "${page.title || 'Untitled'}"? Everyone in this workspace loses it.`)) return
    const next = (list ?? []).find((item) => item.id !== page.id)
    try {
      await pages.remove(page.id)
      if (page.id === pageId) go(next ? { name: 'page', workspaceId: workspace.id, pageId: next.id } : { name: 'workspace', workspaceId: workspace.id }, { replace: true })
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Could not delete the page.', 'error')
    }
  }

  const activePage = pageId ? (list?.find((item) => item.id === pageId) ?? null) : null
  const openMenu = () => setSidebarOpen(true)

  let content
  if (channel.noAccess) content = <Splash />
  else if (!list) {
    content = pages.loadError ? (
      <div className="centered">
        <div className="empty-card">
          <h1>Could not load the pages</h1>
          <p>{pages.loadError}</p>
          <button type="button" className="btn-primary" onClick={() => void pages.retry()}>
            Try again
          </button>
        </div>
      </div>
    ) : (
      <Splash />
    )
  } else if (pageId) {
    content = activePage ? (
      <PageView
        key={activePage.id}
        page={activePage}
        role={workspace.role}
        onRename={(title) => pages.rename(activePage.id, title)}
        onDelete={() => void deletePage(activePage)}
        onOpenMenu={openMenu}
        onHome={goHome}
      />
    ) : (
      <NotFound onHome={goHome} onOpenMenu={openMenu} />
    )
  } else if (list.length === 0) {
    content = <EmptyState canCreate={can(workspace.role, 'page:create')} onCreate={() => void newPage()} onOpenMenu={openMenu} />
  } else {
    content = <Splash />
  }

  return (
    <div className="app" data-sidebar={sidebarOpen ? 'open' : 'closed'}>
      <Sidebar
        workspace={workspace}
        workspaces={workspaces}
        pages={list}
        activeId={pageId}
        status={channel.status}
        open={sidebarOpen}
        onNewPage={() => void newPage()}
        onDeletePage={(page) => void deletePage(page)}
        onNavigate={() => setSidebarOpen(false)}
        onOpenMembers={() => {
          setSidebarOpen(false)
          setMembersOpen(true)
        }}
        onSwitchWorkspace={(id) => {
          setSidebarOpen(false)
          go({ name: 'workspace', workspaceId: id })
        }}
        onNewWorkspace={() => setCreatingWorkspace(true)}
      />
      <div className="backdrop" onClick={() => setSidebarOpen(false)} aria-hidden="true" />
      <main className="main">{content}</main>

      {membersOpen && (
        <MembersDialog
          workspace={workspace}
          version={membersVersion}
          onClose={() => setMembersOpen(false)}
          onChanged={() => void refresh()}
          onGone={() => {
            setMembersOpen(false)
            onLeft()
          }}
        />
      )}
      {creatingWorkspace && (
        <CreateWorkspaceDialog
          onClose={() => setCreatingWorkspace(false)}
          onCreated={(created) => {
            addWorkspace(created)
            setCreatingWorkspace(false)
            setSidebarOpen(false)
            go({ name: 'workspace', workspaceId: created.id })
          }}
        />
      )}
    </div>
  )
}
