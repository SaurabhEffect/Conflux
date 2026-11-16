import type { ConnectionStatus } from '../collab/useCollabDoc'
import type { Peer } from '../collab/usePeers'
import { initialOf } from '../identity'

export function Avatars({ peers }: { peers: Peer[] }) {
  const shown = peers.slice(0, 5)
  const extra = peers.length - shown.length
  if (peers.length === 0) return null
  return (
    <div className="avatars" role="group" aria-label={`${peers.length} here now`}>
      {shown.map((peer) => (
        <span
          key={peer.clientId}
          className="avatar"
          style={{ background: peer.color }}
          title={peer.isMe ? `${peer.name} (you)` : peer.name}
        >
          {initialOf(peer.name)}
        </span>
      ))}
      {extra > 0 && (
        <span className="avatar more" title={`${extra} more`}>
          +{extra}
        </span>
      )}
    </div>
  )
}
const LABELS: Record<ConnectionStatus, string> = {
  connected: 'Live',
  connecting: 'Connecting…',
  disconnected: 'Offline',
}

const HINTS: Record<ConnectionStatus, string> = {
  connected: 'Connected. Your changes sync instantly.',
  connecting: 'Trying to reach the server…',
  disconnected:
    'The server cannot be reached. Keep typing: your edits are saved in this browser and will sync when the server is back.',
}

export function StatusPill({ status, compact = false }: { status: ConnectionStatus; compact?: boolean }) {
  return (
    <span className={`status status-${status}${compact ? ' compact' : ''}`} title={HINTS[status]} role="status">
      <span className="dot" aria-hidden="true" />
      <span className="status-label">{LABELS[status]}</span>
    </span>
  )
}
