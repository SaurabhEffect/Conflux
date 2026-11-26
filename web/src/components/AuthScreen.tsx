import { LIMITS, type DemoInfo, type InvitePreview } from '@conflux/shared'
import { useEffect, useState, type FormEvent } from 'react'
import { api } from '../api'
import { useAuth } from '../auth'
import { useRoute } from '../route'
import { pendingSeeds } from '../session'
import { welcomeHtml } from '../seeds'
import { Icon } from './Icons'
import { LogoMark } from './Logo'
import { ROLE_LABELS } from './RoleBadge'
import { useStartDemo } from './useStartDemo'

type Props = {
  invite?: InvitePreview | null
}

export function AuthScreen({ invite = null }: Props) {
  const auth = useAuth()
  const { go } = useRoute()
  const notice = auth.state.status === 'signedOut' ? auth.state.notice : null
  const [mode, setMode] = useState<'login' | 'signup'>(invite ? 'signup' : 'login')
  const [displayName, setDisplayName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [demo, setDemo] = useState<DemoInfo | null>(null)
  const demoStarter = useStartDemo()

  // Whether the server offers the guest demo (it can be switched off). If this cannot be asked, no demo is offered.
  useEffect(() => {
    let alive = true
    api.demoInfo().then(
      (info) => {
        if (alive) setDemo(info)
      },
      () => undefined,
    )
    return () => {
      alive = false
    }
  }, [])

  const signingUp = mode === 'signup'

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      if (signingUp) {
        const created = await auth.signup({ email, password, displayName })
        // The first page of a new account is empty on the server; this tab fills in the welcome text once.
        pendingSeeds.set(created.welcomePageId, welcomeHtml)
        if (!invite) go({ name: 'page', workspaceId: created.workspaces[0].id, pageId: created.welcomePageId }, { replace: true })
      } else {
        await auth.login({ email, password })
      }
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : 'Something went wrong. Please try again.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="welcome">
      <LogoMark size={120} />
      <form className="welcome-card" onSubmit={submit} aria-labelledby="auth-title">
        <h1 id="auth-title" className="card-title">
          {signingUp ? 'Create your account' : 'Welcome back'}
        </h1>

        {invite && (
          <p className="callout">
            {invite.invitedBy ? <strong>{invite.invitedBy}</strong> : 'Someone'} invited you to <strong>{invite.workspaceName}</strong> as{' '}
            {ROLE_LABELS[invite.role].toLowerCase()}. {signingUp ? 'Create an account' : 'Sign in'} to join.
          </p>
        )}
        {notice && !error && (
          <p className="callout" role="status">
            {notice}
          </p>
        )}

        {signingUp && (
          <div className="field">
            <label htmlFor="auth-name">Your name</label>
            <input
              id="auth-name"
              name="name"
              value={displayName}
              maxLength={LIMITS.displayNameMax}
              autoComplete="name"
              required
              autoFocus
              onChange={(event) => setDisplayName(event.target.value)}
            />
            <span className="hint">Other people see this next to your cursor.</span>
          </div>
        )}

        <div className="field">
          <label htmlFor="auth-email">Email</label>
          <input
            id="auth-email"
            name="email"
            type="email"
            value={email}
            maxLength={LIMITS.emailMax}
            autoComplete="email"
            required
            autoFocus={!signingUp}
            onChange={(event) => setEmail(event.target.value)}
          />
        </div>

        <div className="field">
          <label htmlFor="auth-password">Password</label>
          <input
            id="auth-password"
            name="password"
            type="password"
            value={password}
            maxLength={LIMITS.passwordMax}
            minLength={signingUp ? LIMITS.passwordMin : undefined}
            autoComplete={signingUp ? 'new-password' : 'current-password'}
            required
            onChange={(event) => setPassword(event.target.value)}
          />
          {signingUp && <span className="hint">At least {LIMITS.passwordMin} characters. A few words in a row make a strong one.</span>}
        </div>

        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}

        <button type="submit" className="btn-primary" disabled={busy}>
          {busy ? 'One moment…' : signingUp ? 'Create account' : 'Sign in'}
        </button>

        <p className="muted small switch-mode">
          {signingUp ? 'Already have an account? ' : 'New to Conflux? '}
          <button
            type="button"
            className="link-btn"
            onClick={() => {
              setMode(signingUp ? 'login' : 'signup')
              setError(null)
            }}
          >
            {signingUp ? 'Sign in' : 'Create an account'}
          </button>
        </p>

        {demo?.enabled && !invite && (
          <div className="demo-offer">
            <button type="button" className="btn-secondary" disabled={demoStarter.busy} onClick={() => void demoStarter.start()}>
              <Icon name="bot" size={16} />
              {demoStarter.busy ? 'Starting…' : 'Try the live demo, no account'}
            </button>
            <p className="muted small">
              A throw-away workspace with a bot, for you and a friend. It ends after {demo.idleMinutes} minutes without typing, and nothing is kept.
            </p>
          </div>
        )}
      </form>
    </main>
  )
}
