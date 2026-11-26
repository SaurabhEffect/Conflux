import type { WorkspaceEvent } from '@conflux/shared'
import { workspaceDocName } from '@conflux/shared'
import { useCallback } from 'react'
import { useCollabDoc } from './useCollabDoc'

export type ChannelEvent = WorkspaceEvent['type'] | 'reconnected'

export function useWorkspaceChannel(workspaceId: string, onEvent: (event: ChannelEvent) => void) {
  const onStateless = useCallback(
    (payload: string) => {
      try {
        const message = JSON.parse(payload) as Partial<WorkspaceEvent>
        if (message.type === 'pages' || message.type === 'members' || message.type === 'workspace') onEvent(message.type)
      } catch {
        // Not a message we know. Ignore it.
      }
    },
    [onEvent],
  )
  const onAuthenticated = useCallback(() => onEvent('reconnected'), [onEvent])

  const channel = useCollabDoc(workspaceDocName(workspaceId), { onStateless, onAuthenticated })
  return { status: channel?.status ?? 'connecting', noAccess: channel?.noAccess ?? false }
}
