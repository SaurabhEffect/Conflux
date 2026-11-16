import { useState, type FormEvent } from 'react'
import { randomName } from '../identity'
import { LogoMark } from './Logo'

export function Welcome({ onDone }: { onDone: (name: string) => void }) {
  const [name, setName] = useState(randomName)
  const submit = (event: FormEvent) => {
    event.preventDefault()
    onDone(name)
  }
  return (
    <main className="welcome">
      <LogoMark size={160} />
      <form className="welcome-card" onSubmit={submit}>
        <label htmlFor="display-name">What should we call you?</label>
        <input
          id="display-name"
          value={name}
          maxLength={24}
          autoFocus
          autoComplete="off"
          onChange={(event) => setName(event.target.value)}
        />
        <button type="submit" className="btn-primary">
          Open my workspace
        </button>
        <p className="muted small">
          No account needed. Your name is saved only in this browser. Others see it next to your cursor.
        </p>
      </form>
    </main>
  )
}
