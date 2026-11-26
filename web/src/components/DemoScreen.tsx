import { LIMITS, demoDocName, type DemoPageDto, type DemoState } from '@conflux/shared'
import { useCallback, useEffect, useState } from 'react'
import { ApiError, api } from '../api'
import type { ConnectionStatus } from '../collab/useCollabDoc'
import { useDemoDoc } from '../collab/useDemoDoc'
import { usePeers } from '../collab/usePeers'
import { hrefFor, useRoute } from '../route'
import { useToast } from '../toast'
import { Dialog } from './Dialog'
import { Icon } from './Icons'
import { LogoMark } from './Logo'
import { PageEditor } from './PageEditor'
import { Avatars, StatusPill } from './Presence'
import { FullScreenMessage, MenuButton, Splash } from './Shell'
import { useStartDemo } from './useStartDemo'

const TICKET_SHAPE = /^[A-Za-z0-9_-]{43}$/

type Phase =
  | { kind: 'joining' }
  | { kind: 'ready'; state: DemoState }
  | { kind: 'ended'; byYou: boolean }
  | { kind: 'full' }
  | { kind: 'problem'; message: string }

const joining = new Map<string, Promise<DemoState>>()
function joinOnce(ticket: string): Promise<DemoState> {
  let pending = joining.get(ticket)
  if (!pending) {
    pending = api.joinDemo(ticket).finally(() => {
      window.setTimeout(() => joining.delete(ticket), 0)
    })
    joining.set(ticket, pending)
  }
  return pending
}

function explain(error: unknown): Phase {
  if (error instanceof ApiError) {
    if (error.code === 'demo_ended') return { kind: 'ended', byYou: false }
    if (error.code === 'demo_full') return error.status === 409 ? { kind: 'full' } : { kind: 'problem', message: error.message }
    return { kind: 'problem', message: error.message }
  }
  return { kind: 'problem', message: 'Something went wrong. Please try again.' }
}

export function DemoScreen({ ticket, pageId }: { ticket: string; pageId: string | null }) {
  const { go } = useRoute()
  const { start, busy } = useStartDemo()
  const [phase, setPhase] = useState<Phase>({ kind: 'joining' })
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    if (!TICKET_SHAPE.test(ticket)) {
      setPhase({ kind: 'ended', byYou: false })
      return
    }
    let alive = true
    setPhase({ kind: 'joining' })
    joinOnce(ticket).then(
      (state) => {
        if (alive) setPhase({ kind: 'ready', state })
      },
      (error: unknown) => {
        if (alive) setPhase(explain(error))
      },
    )
    return () => {
      alive = false
    }
  }, [ticket, attempt])

  const onEnded = useCallback((byYou: boolean) => {
    // Ending it yourself is the clearest message, so a later "the server closed us" does not replace it.
    setPhase((current) => (current.kind === 'ended' && current.byYou ? current : { kind: 'ended', byYou }))
  }, [])
  const home = () => go({ name: 'home' }, { replace: true })

  switch (phase.kind) {
    case 'joining':
      return (
        <main className="welcome">
          <LogoMark size={120} />
          <p className="muted" role="status">
            Opening the demo…
          </p>
        </main>
      )
    case 'ready':
      return <DemoWorkspace key={ticket} ticket={ticket} state={phase.state} pageId={pageId} onEnded={onEnded} />
    case 'ended':
      return (
        <FullScreenMessage
          title={phase.byYou ? 'Demo ended and deleted' : 'This demo has ended'}
          text={
            phase.byYou
              ? 'Every page, edit and visitor of it was deleted. Nothing was kept.'
              : 'Demos are throw-away. The host can end one, and each one ends by itself after a while without typing, or after a few hours. Nothing from it was kept, and this link no longer works.'
          }
          action={busy ? 'Starting…' : 'Start a new demo'}
          onAction={() => void start()}
          secondary="Back to Conflux"
          onSecondary={home}
        />
      )
    case 'full':
      return (
        <FullScreenMessage
          title="This demo is full"
          text={`A demo holds up to ${LIMITS.demoMaxParticipants} people. You can start one of your own and invite your friends to that.`}
          action={busy ? 'Starting…' : 'Start my own demo'}
          onAction={() => void start()}
          secondary="Back to Conflux"
          onSecondary={home}
        />
      )
    case 'problem':
      return (
        <FullScreenMessage
          title="Cannot open the demo"
          text={phase.message}
          action="Try again"
          onAction={() => setAttempt((count) => count + 1)}
          secondary="Back to Conflux"
          onSecondary={home}
        />
      )
  }
}

function formatLeft(ms: number): string {
  const minutes = Math.max(1, Math.ceil(ms / 60_000))
  if (minutes < 60) return `${minutes} min`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`
}

function useTimeLeft(endsAt: string): number {
  const end = new Date(endsAt).getTime()
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 15_000)
    return () => window.clearInterval(timer)
  }, [])
  return Math.max(0, end - now)
}

type WorkspaceProps = { ticket: string; state: DemoState; pageId: string | null; onEnded: (byYou: boolean) => void }

function DemoWorkspace({ ticket, state, pageId, onEnded }: WorkspaceProps) {
  const { go } = useRoute()
  const toast = useToast()
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [inviting, setInviting] = useState(false)
  const [status, setStatus] = useState<ConnectionStatus>('connecting')
  const [busy, setBusy] = useState(false)
  const left = useTimeLeft(state.endsAt)

  const active = state.pages.find((page) => page.id === pageId) ?? null
  const firstId = state.pages[0]?.id ?? null
  useEffect(() => {
    // An address without a page (or with a page of some other demo) lands on the first page.
    if (!active && firstId) go({ name: 'demo', ticket, pageId: firstId }, { replace: true })
  }, [active, firstId, ticket, go])

  useEffect(() => {
    if (left <= 0) onEnded(false)
  }, [left, onEnded])

  async function end() {
    if (busy) return
    if (!window.confirm('End the demo for everyone? Every page, edit and visitor in it is deleted.')) return
    setBusy(true)
    try {
      await api.endDemo()
      onEnded(true)
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Could not end the demo.', 'error')
      setBusy(false)
    }
  }

  async function leave() {
    if (busy) return
    setBusy(true)
    try {
      await api.leaveDemo()
      go({ name: 'home' }, { replace: true })
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Could not leave the demo.', 'error')
      setBusy(false)
    }
  }

  const idleMinutes = Math.round(state.idleSeconds / 60)
  return (
    <div className="app" data-sidebar={sidebarOpen ? 'open' : 'closed'}>
      <aside className="sidebar" data-open={sidebarOpen} aria-label="Demo">
        <div className="brand">
          <LogoMark size={40} />
          <span className="brand-name">Conflux</span>
        </div>
        <span className="demo-tag">
          <Icon name="bot" size={14} />
          Guest demo
        </span>

        <nav className="page-list" aria-label="Pages">
          <div className="section-label">Pages</div>
          <ul>
            {state.pages.map((page) => (
              <li key={page.id} className={page.id === active?.id ? 'active' : undefined}>
                <a
                  href={hrefFor({ name: 'demo', ticket, pageId: page.id })}
                  aria-current={page.id === active?.id ? 'page' : undefined}
                  onClick={() => setSidebarOpen(false)}
                >
                  <Icon name="doc" size={16} />
                  <span className="page-title">{page.title}</span>
                </a>
              </li>
            ))}
          </ul>
        </nav>

        <div className="sidebar-foot">
          <p className="demo-note">
            You are <strong>{state.me.displayName}</strong>. This is a throw-away demo: it ends in <strong>{formatLeft(left)}</strong>, or after {idleMinutes}{' '}
            minutes without typing.
          </p>
          <button type="button" className="btn-members" onClick={() => setInviting(true)}>
            <Icon name="users" size={16} />
            <span>Invite someone</span>
          </button>
          {state.me.isHost ? (
            <button type="button" className="btn-secondary" disabled={busy} onClick={() => void end()}>
              End demo for everyone
            </button>
          ) : (
            <button type="button" className="btn-secondary" disabled={busy} onClick={() => void leave()}>
              Leave demo
            </button>
          )}
          <StatusPill status={status} />
          <a className="link-btn demo-signup" href={hrefFor({ name: 'home' })}>
            Like it? Create a free account
          </a>
        </div>
      </aside>
      <div className="backdrop" onClick={() => setSidebarOpen(false)} aria-hidden="true" />

      <main className="main">
        {active ? (
          <DemoPageView
            key={active.id}
            page={active}
            me={state.me}
            onOpenMenu={() => setSidebarOpen(true)}
            onEnded={onEnded}
            onStatus={setStatus}
          />
        ) : (
          <Splash />
        )}
      </main>

      {inviting && <InviteDialog ticket={ticket} onClose={() => setInviting(false)} />}
    </div>
  )
}

type PageProps = {
  page: DemoPageDto
  me: DemoState['me']
  onOpenMenu: () => void
  onEnded: (byYou: boolean) => void
  onStatus: (status: ConnectionStatus) => void
}

function DemoPageView({ page, me, onOpenMenu, onEnded, onStatus }: PageProps) {
  const collab = useDemoDoc(demoDocName(page.id))
  const peers = usePeers(collab?.provider ?? null)
  const [hintOpen, setHintOpen] = useState(true)
  const noAccess = collab?.noAccess ?? false
  const status = collab?.status ?? 'connecting'

  useEffect(() => {
    if (noAccess) onEnded(false)
  }, [noAccess, onEnded])
  useEffect(() => {
    onStatus(status)
  }, [status, onStatus])

  return (
    <section className="page">
      <header className="page-header">
        <MenuButton onClick={onOpenMenu} />
        {/* Titles of demo pages are fixed. */}
        <input className="title-input" value={page.title} readOnly aria-label="Page title" />
        <Avatars peers={peers} />
        <span className="only-mobile">
          <StatusPill status={status} compact />
        </span>
      </header>
      {hintOpen && (
        <p className="banner demo-hint" role="note">
          <Icon name="bot" size={16} />
          <span>
            Try it: write <code>@bot help</code> on a line of its own and press Enter. Open the invite link in a second window to see two people typing together.
          </span>
          <button type="button" className="icon-btn" aria-label="Hide this hint" onClick={() => setHintOpen(false)}>
            <Icon name="close" size={14} />
          </button>
        </p>
      )}
      {collab?.ready ? (
        <PageEditor pageId={page.id} doc={collab.doc} provider={collab.provider} user={{ name: me.displayName, color: me.cursorColor }} editable />
      ) : (
        <Splash />
      )}
    </section>
  )
}

function InviteDialog({ ticket, onClose }: { ticket: string; onClose: () => void }) {
  const [copied, setCopied] = useState<'yes' | 'no' | null>(null)
  // The address of this app plus the link's own part (after the #). The part after the # is never sent to a server.
  const link = `${window.location.origin}${window.location.pathname}${hrefFor({ name: 'demo', ticket, pageId: null })}`

  async function copy() {
    try {
      await navigator.clipboard.writeText(link)
      setCopied('yes')
    } catch {
      setCopied('no') // clipboard blocked (for example on a plain http address): the link is selected for Ctrl+C instead
    }
  }

  return (
    <Dialog title="Invite someone to this demo" onClose={onClose}>
      <div className="stack">
        <p className="muted">
          Send this link. Anyone who opens it joins this demo, without an account (up to {LIMITS.demoMaxParticipants} people). You can also open it in a second window to see
          yourself from the other side.
        </p>
        <div className="copy-row">
          <input readOnly value={link} aria-label="Demo link" data-autofocus onFocus={(event) => event.target.select()} />
          <button type="button" className="btn-secondary" onClick={() => void copy()}>
            <Icon name="copy" size={15} /> Copy
          </button>
        </div>
        {copied === 'yes' && <span className="small live-text">Copied to the clipboard.</span>}
        {copied === 'no' && <span className="small">Could not copy automatically. Select the link above and press Ctrl+C.</span>}
        <p className="muted small">Anyone with the link can edit. It stops working the moment the demo ends.</p>
      </div>
    </Dialog>
  )
}
