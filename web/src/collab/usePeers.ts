import type { HocuspocusProvider } from '@hocuspocus/provider'
import { useEffect, useRef, useState } from 'react'

export type Peer = {
  clientId: number
  name: string
  color: string
  isMe: boolean
}

export function usePeers(provider: HocuspocusProvider | null): Peer[] {
  const [peers, setPeers] = useState<Peer[]>([])
  const lastKey = useRef('')
  useEffect(() => {
    const awareness = provider?.awareness
    if (!awareness) return
    const update = () => {
      const list: Peer[] = []
      awareness.getStates().forEach((state, clientId) => {
        const user = state.user as { name?: string; color?: string } | undefined
        if (!user?.name) return
        list.push({
          clientId,
          name: user.name,
          color: user.color ?? '#5b6b8c',
          isMe: clientId === awareness.clientID,
        })
      })
      list.sort((a, b) => Number(b.isMe) - Number(a.isMe) || a.name.localeCompare(b.name))
      const key = JSON.stringify(list)
      if (key !== lastKey.current) {
        lastKey.current = key
        setPeers(list)
      }
    }
    let queued = false
    let alive = true
    const schedule = () => {
      if (queued) return
      queued = true
      queueMicrotask(() => {
        queued = false
        if (alive) update()
      })
    }
    schedule()
    awareness.on('change', schedule)
    return () => {
      alive = false
      awareness.off('change', schedule)
    }
  }, [provider])
  return peers
}
