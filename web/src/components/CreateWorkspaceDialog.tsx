import { LIMITS, type WorkspaceDto } from '@conflux/shared'
import { useState, type FormEvent } from 'react'
import { api } from '../api'
import { Dialog } from './Dialog'
import { useAction } from './useAction'

export function CreateWorkspaceDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (workspace: WorkspaceDto) => void }) {
  const [name, setName] = useState('')
  const action = useAction()

  async function submit(event: FormEvent) {
    event.preventDefault()
    const result = await action.run(() => api.createWorkspace(name))
    if (result) onCreated(result.value)
  }

  return (
    <Dialog title="New workspace" onClose={onClose}>
      <form className="stack" onSubmit={submit}>
        <div className="field">
          <label htmlFor="new-workspace-name">Workspace name</label>
          <input
            id="new-workspace-name"
            value={name}
            maxLength={LIMITS.workspaceNameMax}
            required
            autoComplete="off"
            data-autofocus
            onChange={(event) => setName(event.target.value)}
          />
          <span className="hint">You will be its owner. Nobody else can see it until you invite them.</span>
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
            {action.busy ? 'Creating…' : 'Create workspace'}
          </button>
        </div>
      </form>
    </Dialog>
  )
}
