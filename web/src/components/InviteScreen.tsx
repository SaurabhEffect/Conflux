import type { InvitePreview } from '@conflux/shared'
import { useEffect, useState, type ReactNode } from 'react'
import { api } from '../api'
import { useAuth } from '../auth'
import { useRoute } from '../route'
import { AuthScreen } from './AuthScreen'
import { LogoMark } from './Logo'
import { ROLE_HELP, ROLE_LABELS } from './RoleBadge'
import { useAction } from './useAction'

const TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/
const BAD_LINK = 'This invite link is not valid. Ask for a new one.'

export function InviteScreen({ token }: { token: string }) {
  const auth = useAuth()
  const { go } = useRoute()
  const shapeOk = TOKEN_SHAPE.test(token)
  const [preview, setPreview] = useState<InvitePreview | null>(null)
  const [problem, setProblem] = useState<string | null>(shapeOk ? null : BAD_LINK)
  const join = useAction()

  useEffect(() => {
    if (!shapeOk) return
    let cancelled = false
    api.previewInvite(token).then(
      (found) => {
        if (!cancelled) setPreview(found)
      },
      (error: Error) => {
        if (!cancelled) setProblem(error.message)
      },
    )
    return () => {
      cancelled = true
    }
  }, [token, shapeOk])

  const leave = () => go({ name: 'home' }, { replace: true })

  if (auth.state.status === 'loading') return <Waiting />
  if (auth.state.status === 'unreachable') return <Waiting text={auth.state.message} />

  if (problem) {
    return (
      <Card title="This invite cannot be used">
        <p className="muted">{problem}</p>
        <button type="button" className="btn-primary" onClick={leave}>
          {auth.state.status === 'signedIn' ? 'Go to my workspaces' : 'Go to Conflux'}
        </button>
      </Card>
    )
  }
  if (!preview) return <Waiting />

  if (auth.state.status === 'signedOut') return <AuthScreen invite={preview} />

  const accept = async () => {
    const result = await join.run(() => api.acceptInvite(token))
    if (!result) return
    auth.addWorkspace(result.value)
    go({ name: 'workspace', workspaceId: result.value.id }, { replace: true })
  }

  return (
    <Card title={`Join ${preview.workspaceName}`}>
      <p className="muted">
        {preview.invitedBy ? <strong>{preview.invitedBy}</strong> : 'Someone'} invited you as {ROLE_LABELS[preview.role].toLowerCase()}.
      </p>
      <p className="muted small">{ROLE_HELP[preview.role]}</p>
      {join.error && (
        <p className="form-error" role="alert">
          {join.error}
        </p>
      )}
      <button type="button" className="btn-primary" disabled={join.busy} onClick={() => void accept()} autoFocus>
        {join.busy ? 'Joining…' : 'Join workspace'}
      </button>
      <button type="button" className="link-btn" onClick={leave}>
        Not now
      </button>
    </Card>
  )
}

function Card({ title, children }: { title: string; children: ReactNode }) {
  return (
    <main className="welcome">
      <LogoMark size={120} />
      <div className="welcome-card" role="region" aria-label={title}>
        <h1 className="card-title">{title}</h1>
        {children}
      </div>
    </main>
  )
}

function Waiting({ text = 'Checking the invite…' }: { text?: string }) {
  return (
    <main className="welcome">
      <LogoMark size={120} />
      <p className="muted" role="status">
        {text}
      </p>
    </main>
  )
}
