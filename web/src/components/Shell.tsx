import { Component, type ErrorInfo, type ReactNode } from 'react'
import { Icon } from './Icons'
import { LogoMark } from './Logo'

export function MenuButton({ onClick }: { onClick: () => void }) {
  return (
    <button type="button" className="icon-btn menu-btn" aria-label="Open pages" onClick={onClick}>
      <Icon name="menu" size={20} />
    </button>
  )
}

export function Splash() {
  return (
    <div className="skeleton" role="status" aria-label="Loading">
      <span style={{ width: '42%', height: 26 }} />
      <span style={{ width: '92%' }} />
      <span style={{ width: '86%' }} />
      <span style={{ width: '64%' }} />
    </div>
  )
}

export function FullScreenMessage({
  title,
  text,
  action,
  onAction,
  secondary,
  onSecondary,
}: {
  title: string
  text: string
  action?: string
  onAction?: () => void
  secondary?: string
  onSecondary?: () => void
}) {
  return (
    <main className="welcome">
      <LogoMark size={120} />
      <div className="welcome-card" role="region" aria-label={title}>
        <h1 className="card-title">{title}</h1>
        <p className="muted">{text}</p>
        {action && onAction && (
          <button type="button" className="btn-primary" onClick={onAction} autoFocus>
            {action}
          </button>
        )}
        {secondary && onSecondary && (
          <button type="button" className="link-btn" onClick={onSecondary}>
            {secondary}
          </button>
        )}
      </div>
    </main>
  )
}

export function EmptyState({ canCreate, onCreate, onOpenMenu }: { canCreate: boolean; onCreate: () => void; onOpenMenu: () => void }) {
  return (
    <div className="centered">
      <div className="mobile-bar">
        <MenuButton onClick={onOpenMenu} />
      </div>
      <div className="empty-card">
        <LogoMark size={72} />
        <h1>{canCreate ? 'This workspace has no pages yet' : 'Nothing to read yet'}</h1>
        <p>{canCreate ? 'Create the first page to start writing together.' : 'An editor or owner has not created any pages yet. They will show up here as soon as they do.'}</p>
        {canCreate && (
          <button type="button" className="btn-primary" onClick={onCreate}>
            Create a page
          </button>
        )}
      </div>
    </div>
  )
}

export function NotFound({ onHome, onOpenMenu }: { onHome: () => void; onOpenMenu: () => void }) {
  return (
    <div className="centered">
      <div className="mobile-bar">
        <MenuButton onClick={onOpenMenu} />
      </div>
      <div className="empty-card">
        <LogoMark size={72} />
        <h1>This page is gone</h1>
        <p>It was deleted, or the link is not from this workspace.</p>
        <button type="button" className="btn-primary" onClick={onHome}>
          Back to my pages
        </button>
      </div>
    </div>
  )
}

export class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() {
    return { failed: true }
  }
  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('Conflux crashed:', error, info.componentStack)
  }
  render() {
    if (!this.state.failed) return this.props.children
    return (
      <FullScreenMessage
        title="Something went wrong"
        text="The page hit an unexpected problem. Your work is saved. Reloading usually fixes it."
        action="Reload"
        onAction={() => window.location.reload()}
      />
    )
  }
}
