import { HocuspocusProvider, HocuspocusProviderWebsocket } from '@hocuspocus/provider'
import { useEffect, useState } from 'react'
import { IndexeddbPersistence } from 'y-indexeddb'
import * as Y from 'yjs'
import { COLLAB_URL } from '../config'
import type { Identity } from '../identity'

export type ConnectionStatus = 'connecting' | 'connected' | 'disconnected'
export type CollabDoc = {
  doc: Y.Doc
  provider: HocuspocusProvider
  ready: boolean
  status: ConnectionStatus
}

export function useCollabDoc(name: string, user?: Identity): CollabDoc | null {
  const [connection, setConnection] = useState<{ doc: Y.Doc; provider: HocuspocusProvider } | null>(null)
  const [ready, setReady] = useState(false)
  const [status, setStatus] = useState<ConnectionStatus>('connecting')
  useEffect(() => {
    let disconnect: (() => void) | undefined
    const timer = window.setTimeout(() => {
      const doc = new Y.Doc()
      const saved = new IndexeddbPersistence(`conflux:${name}`, doc)
      const socket = new HocuspocusProviderWebsocket({ url: COLLAB_URL, maxDelay: 4000 })
      const provider = new HocuspocusProvider({ name, document: doc, websocketProvider: socket })
      provider.attach()
      if (user) provider.setAwarenessField('user', { name: user.name, color: user.color })
      let alive = true
      const markReady = () => {
        if (alive) setReady(true)
      }
      provider.on('status', (event: { status: ConnectionStatus }) => {
        if (alive) setStatus(event.status)
      })
      provider.on('synced', markReady)
      if (provider.synced) markReady()
      void saved.whenSynced.then(() => {
        if (Y.encodeStateAsUpdate(doc).length > 2) markReady()
      })
      const offlineTimer = window.setTimeout(() => {
        if (socket.status !== 'connected') markReady()
      }, 2000)
      const lastResortTimer = window.setTimeout(markReady, 10000)
      setReady(false)
      setStatus('connecting')
      setConnection({ doc, provider })
      disconnect = () => {
        alive = false
        window.clearTimeout(offlineTimer)
        window.clearTimeout(lastResortTimer)
        provider.destroy()
        socket.destroy()
        void saved.destroy()
      }
    }, 0)
    return () => {
      window.clearTimeout(timer)
      disconnect?.()
    }
  }, [name])
  return connection ? { ...connection, ready, status } : null
}
