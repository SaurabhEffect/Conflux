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

export function EmptyState({ onCreate, onOpenMenu }: { onCreate: () => void; onOpenMenu: () => void }) {
  return (
    <div className="centered">
      <div className="mobile-bar">
        <MenuButton onClick={onOpenMenu} />
      </div>
      <div className="empty-card">
        <LogoMark size={72} />
        <h1>Your workspace is empty</h1>
        <p>Create your first page. We will add a short welcome page that shows what Conflux can do.</p>
        <button type="button" className="btn-primary" onClick={onCreate}>
          Create the welcome page
        </button>
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
