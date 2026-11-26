import { LIMITS, ROLES, can, type InviteDto, type MemberDto, type Role, type WorkspaceDto } from '@conflux/shared'
import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { api } from '../api'
import { useSession } from '../auth'
import { hrefFor } from '../route'
import { formatWhen, initialOf } from '../util'
import { Dialog } from './Dialog'
import { Icon } from './Icons'
import { ROLE_HELP, ROLE_LABELS, RoleBadge } from './RoleBadge'
import { useAction } from './useAction'

type Tab = 'people' | 'invites' | 'settings'

type Props = {
  workspace: WorkspaceDto
  version: number
  onClose: () => void
  onGone: () => void
  onChanged: () => void
}

export function MembersDialog({ workspace, version, onClose, onGone, onChanged }: Props) {
  const isOwner = can(workspace.role, 'members:manage')
  const [tab, setTab] = useState<Tab>('people')
  const tabs: { id: Tab; label: string }[] = [
    { id: 'people', label: 'People' },
    ...(isOwner ? [{ id: 'invites' as const, label: 'Invite links' }, { id: 'settings' as const, label: 'Settings' }] : []),
  ]

  return (
    <Dialog title={workspace.name} onClose={onClose} wide>
      {tabs.length > 1 && (
        <div className="tabs" role="tablist" aria-label="Workspace">
          {tabs.map((item) => (
            <button
              key={item.id}
              type="button"
              role="tab"
              id={`tab-${item.id}`}
              aria-selected={tab === item.id}
              aria-controls={`panel-${item.id}`}
              className="tab"
              onClick={() => setTab(item.id)}
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
      <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`}>
        {tab === 'people' && <People workspace={workspace} version={version} onGone={onGone} onChanged={onChanged} />}
        {tab === 'invites' && isOwner && <Invites workspace={workspace} />}
        {tab === 'settings' && isOwner && <Settings workspace={workspace} onGone={onGone} onChanged={onChanged} />}
      </div>
    </Dialog>
  )
}

function People({ workspace, version, onGone, onChanged }: Pick<Props, 'workspace' | 'version' | 'onGone' | 'onChanged'>) {
  const { user } = useSession()
  const isOwner = can(workspace.role, 'members:manage')
  const [members, setMembers] = useState<MemberDto[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const action = useAction()

  const load = useCallback(async () => {
    try {
      const { members: list } = await api.members(workspace.id)
      setMembers(list)
      setLoadError(null)
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : 'Could not load the members.')
    }
  }, [workspace.id])

  useEffect(() => {
    void load()
  }, [load, version])

  const onlyOwner = isOwner && members !== null && members.filter((member) => member.role === 'owner').length === 1

  async function changeRole(member: MemberDto, role: Role) {
    if (role === member.role) return
    const result = await action.run(() => api.setRole(workspace.id, member.userId, role))
    await load()
    if (result && member.userId === user.id) onChanged()
  }

  async function remove(member: MemberDto) {
    if (!window.confirm(`Remove ${member.displayName} from "${workspace.name}"? They lose access right away.`)) return
    const result = await action.run(() => api.removeMember(workspace.id, member.userId))
    if (result) await load()
  }

  async function leave() {
    if (!window.confirm(`Leave "${workspace.name}"? You will need a new invite link to come back.`)) return
    const result = await action.run(() => api.removeMember(workspace.id, user.id))
    if (result) onGone()
  }

  return (
    <div className="stack">
      {loadError && (
        <p className="form-error" role="alert">
          {loadError}
        </p>
      )}
      {!members && !loadError && <p className="muted">Loading…</p>}
      {members && (
        <ul className="member-list" aria-label="Members">
          {members.map((member) => (
            <li key={member.userId} className="member">
              <span className="avatar" style={{ background: member.cursorColor }} aria-hidden="true">
                {initialOf(member.displayName)}
              </span>
              <span className="member-info">
                <span className="member-name">
                  {member.displayName}
                  {member.userId === user.id && <span className="muted"> (you)</span>}
                </span>
                {member.email && <span className="muted small">{member.email}</span>}
              </span>
              {isOwner ? (
                <select
                  aria-label={`Role of ${member.displayName}`}
                  value={member.role}
                  disabled={action.busy || (onlyOwner && member.userId === user.id)}
                  title={onlyOwner && member.userId === user.id ? 'Make someone else an owner before changing your own role' : undefined}
                  onChange={(event) => void changeRole(member, event.target.value as Role)}
                >
                  {ROLES.map((role) => (
                    <option key={role} value={role}>
                      {ROLE_LABELS[role]}
                    </option>
                  ))}
                </select>
              ) : (
                <RoleBadge role={member.role} />
              )}
              {isOwner && member.userId !== user.id && (
                <button
                  type="button"
                  className="icon-btn row-action"
                  aria-label={`Remove ${member.displayName}`}
                  title="Remove from workspace"
                  disabled={action.busy}
                  onClick={() => void remove(member)}
                >
                  <Icon name="trash" size={16} />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {action.error && (
        <p className="form-error" role="alert">
          {action.error}
        </p>
      )}

      <dl className="role-help">
        {ROLES.map((role) => (
          <div key={role}>
            <dt>{ROLE_LABELS[role]}</dt>
            <dd>{ROLE_HELP[role]}</dd>
          </div>
        ))}
      </dl>

      <div className="actions actions-start">
        <button type="button" className="btn-secondary" disabled={action.busy || onlyOwner} onClick={() => void leave()}>
          Leave workspace
        </button>
        {onlyOwner && (
          <span className="muted small">
            You are the only owner. Make someone else an owner first, or delete the workspace under Settings.
          </span>
        )}
      </div>
    </div>
  )
}

const EXPIRY_CHOICES = [
  { hours: 24, label: '1 day' },
  { hours: 24 * 7, label: '7 days' },
  { hours: 24 * 30, label: '30 days' },
]
const USE_CHOICES = [1, 5, 10, 25, 50]

function inviteLink(token: string): string {
  return new URL(hrefFor({ name: 'join', token }), window.location.href).toString()
}

function Invites({ workspace }: { workspace: WorkspaceDto }) {
  const [list, setList] = useState<InviteDto[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [role, setRole] = useState<'editor' | 'viewer'>('editor')
  const [hours, setHours] = useState<number>(LIMITS.inviteDefaultHours)
  const [uses, setUses] = useState<number>(LIMITS.inviteDefaultUses)
  const [fresh, setFresh] = useState<{ link: string; role: Role } | null>(null)
  const [copied, setCopied] = useState<'yes' | 'no' | null>(null)
  const action = useAction()

  const load = useCallback(async () => {
    try {
      const { invites } = await api.invites(workspace.id)
      setList(invites)
      setLoadError(null)
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : 'Could not load the invite links.')
    }
  }, [workspace.id])

  useEffect(() => {
    void load()
  }, [load])

  async function create(event: FormEvent) {
    event.preventDefault()
    const result = await action.run(() => api.createInvite(workspace.id, { role, expiresInHours: hours, maxUses: uses }))
    if (!result) return
    setFresh({ link: inviteLink(result.value.token), role })
    setCopied(null)
    await load()
  }

  async function revoke(invite: InviteDto) {
    const result = await action.run(() => api.revokeInvite(workspace.id, invite.id))
    if (result) await load()
  }

  async function copy(link: string) {
    try {
      await navigator.clipboard.writeText(link)
      setCopied('yes')
    } catch {
      setCopied('no') // clipboard blocked (for example on a plain http address): the link is selected for Ctrl+C instead
    }
  }

  return (
    <div className="stack">
      <p className="muted small">
        Anyone with a link can join with the role you pick, once they have an account. Links stop working when they expire, run out of uses
        or are revoked.
      </p>

      <form className="invite-form" onSubmit={create}>
        <div className="field">
          <label htmlFor="invite-role">Role</label>
          <select id="invite-role" value={role} onChange={(event) => setRole(event.target.value as 'editor' | 'viewer')}>
            <option value="editor">Editor</option>
            <option value="viewer">Viewer</option>
          </select>
        </div>
        <div className="field">
          <label htmlFor="invite-hours">Expires after</label>
          <select id="invite-hours" value={hours} onChange={(event) => setHours(Number(event.target.value))}>
            {EXPIRY_CHOICES.map((choice) => (
              <option key={choice.hours} value={choice.hours}>
                {choice.label}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="invite-uses">Can be used</label>
          <select id="invite-uses" value={uses} onChange={(event) => setUses(Number(event.target.value))}>
            {USE_CHOICES.map((count) => (
              <option key={count} value={count}>
                {count === 1 ? '1 time' : `${count} times`}
              </option>
            ))}
          </select>
        </div>
        <button type="submit" className="btn-primary" disabled={action.busy}>
          Create link
        </button>
      </form>

      {action.error && (
        <p className="form-error" role="alert">
          {action.error}
        </p>
      )}

      {fresh && (
        <div className="fresh-link" role="status">
          <strong>New {ROLE_LABELS[fresh.role].toLowerCase()} link</strong>
          <span className="muted small">Copy it now. For safety it is shown only this once.</span>
          <div className="copy-row">
            <input readOnly value={fresh.link} aria-label="Invite link" onFocus={(event) => event.target.select()} />
            <button type="button" className="btn-secondary" onClick={() => void copy(fresh.link)}>
              <Icon name="copy" size={15} /> Copy
            </button>
          </div>
          {copied === 'yes' && <span className="small live-text">Copied to the clipboard.</span>}
          {copied === 'no' && <span className="small">Could not copy automatically. Select the link above and press Ctrl+C.</span>}
        </div>
      )}

      <h3 className="subhead">Active links</h3>
      {loadError && (
        <p className="form-error" role="alert">
          {loadError}
        </p>
      )}
      {list && list.length === 0 && <p className="muted small">No active links.</p>}
      {list && list.length > 0 && (
        <ul className="invite-list" aria-label="Active invite links">
          {list.map((invite) => (
            <li key={invite.id} className="invite">
              <RoleBadge role={invite.role} />
              <span className="invite-info small">
                Expires {formatWhen(invite.expiresAt)} · {invite.usesLeft} {invite.usesLeft === 1 ? 'use' : 'uses'} left
                {invite.createdByName ? ` · made by ${invite.createdByName}` : ''}
              </span>
              <button type="button" className="btn-secondary btn-small" disabled={action.busy} onClick={() => void revoke(invite)}>
                Revoke
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function Settings({ workspace, onGone, onChanged }: Pick<Props, 'workspace' | 'onGone' | 'onChanged'>) {
  const [name, setName] = useState(workspace.name)
  const [confirmation, setConfirmation] = useState('')
  const rename = useAction()
  const remove = useAction()

  async function saveName(event: FormEvent) {
    event.preventDefault()
    const result = await rename.run(() => api.renameWorkspace(workspace.id, name))
    if (result) onChanged()
  }

  async function deleteWorkspace(event: FormEvent) {
    event.preventDefault()
    const result = await remove.run(() => api.deleteWorkspace(workspace.id))
    if (result) onGone()
  }

  const confirmed = confirmation.trim() === workspace.name

  return (
    <div className="stack">
      <form className="stack" onSubmit={saveName}>
        <div className="field">
          <label htmlFor="workspace-name">Workspace name</label>
          <input id="workspace-name" value={name} maxLength={LIMITS.workspaceNameMax} required onChange={(event) => setName(event.target.value)} />
        </div>
        {rename.error && (
          <p className="form-error" role="alert">
            {rename.error}
          </p>
        )}
        <div className="actions actions-start">
          <button type="submit" className="btn-primary" disabled={rename.busy || name.trim() === workspace.name}>
            Save name
          </button>
        </div>
      </form>

      <form className="danger-zone stack" onSubmit={deleteWorkspace}>
        <h3 className="subhead">Delete this workspace</h3>
        <p className="muted small">
          This deletes every page and removes every member. It cannot be undone. Type <strong>{workspace.name}</strong> to confirm.
        </p>
        <input
          aria-label="Type the workspace name to confirm"
          value={confirmation}
          autoComplete="off"
          onChange={(event) => setConfirmation(event.target.value)}
        />
        {remove.error && (
          <p className="form-error" role="alert">
            {remove.error}
          </p>
        )}
        <div className="actions actions-start">
          <button type="submit" className="btn-danger" disabled={!confirmed || remove.busy}>
            Delete workspace
          </button>
        </div>
      </form>
    </div>
  )
}
