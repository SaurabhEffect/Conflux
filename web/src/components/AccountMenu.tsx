import { LIMITS } from '@conflux/shared'
import { useCallback, useRef, useState, type FormEvent } from 'react'
import { useSession } from '../auth'
import { useToast } from '../toast'
import { initialOf } from '../util'
import { Dialog } from './Dialog'
import { Icon } from './Icons'
import { useAction } from './useAction'
import { useDismiss } from './useDismiss'

export function AccountMenu() {
  const { user, logout } = useSession()
  const toast = useToast()
  const [open, setOpen] = useState(false)
  const [editing, setEditing] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const close = useCallback(() => setOpen(false), [])
  useDismiss(open, root, close)

  async function signOut() {
    close()
    try {
      await logout()
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Could not sign out. Try again.', 'error')
    }
  }

  return (
    <div className="account" ref={root}>
      <button
        type="button"
        className="account-btn"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Account: ${user.displayName}`}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="avatar" style={{ background: user.cursorColor }} aria-hidden="true">
          {initialOf(user.displayName)}
        </span>
        <span className="you-name" title={user.email}>
          {user.displayName}
        </span>
        <Icon name="chevronDown" size={16} />
      </button>
      {open && (
        <div className="menu menu-up" role="menu">
          <div className="menu-note" role="presentation">
            {user.email}
          </div>
          <button
            type="button"
            role="menuitem"
            className="menu-item"
            onClick={() => {
              close()
              setEditing(true)
            }}
          >
            <span className="menu-label">Change my name</span>
          </button>
          <button type="button" role="menuitem" className="menu-item" onClick={() => void signOut()}>
            <span className="menu-label">Sign out</span>
            <Icon name="logout" size={15} />
          </button>
        </div>
      )}
      {editing && <NameDialog onClose={() => setEditing(false)} />}
    </div>
  )
}

function NameDialog({ onClose }: { onClose: () => void }) {
  const { user, rename } = useSession()
  const [name, setName] = useState(user.displayName)
  const action = useAction()

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (await action.run(() => rename(name))) onClose()
  }

  return (
    <Dialog title="Your name" onClose={onClose}>
      <form className="stack" onSubmit={submit}>
        <div className="field">
          <label htmlFor="account-name">Display name</label>
          <input
            id="account-name"
            value={name}
            maxLength={LIMITS.displayNameMax}
            required
            autoComplete="name"
            data-autofocus
            onChange={(event) => setName(event.target.value)}
          />
          <span className="hint">Shown next to your cursor and in the member list.</span>
        </div>
        {action.error && (
          <p className="form-error" role="alert">
            {action.error}
          </p>
        )}
        <div className="actions">
          <button type="button" className="btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn-primary" disabled={action.busy}>
            Save
          </button>
        </div>
      </form>
    </Dialog>
  )
}
