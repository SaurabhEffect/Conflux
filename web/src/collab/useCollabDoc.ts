import { CLOSE_CODES } from '@conflux/shared'
import { HocuspocusProvider, HocuspocusProviderWebsocket } from '@hocuspocus/provider'
import { useEffect, useRef, useState } from 'react'
import { IndexeddbPersistence } from 'y-indexeddb'
import * as Y from 'yjs'
import { ApiError, api } from '../api'
import { useSession } from '../auth'
import { COLLAB_URL } from '../config'
import { localStoreName } from './localStore'

export type ConnectionStatus = 'connecting' | 'connected' | 'disconnected'
export type Scope = 'readonly' | 'read-write'

export type CollabOptions = {
  workspaceId?: string
  onStateless?: (payload: string) => void
  onAuthenticated?: () => void
}

export type CollabDoc = {
  doc: Y.Doc
  provider: HocuspocusProvider
  ready: boolean
  status: ConnectionStatus
  scope: Scope | null
  noAccess: boolean
}

type CloseInfo = { event: { code: number; reason: string } }

export function useCollabDoc(docName: string, options: CollabOptions = {}): CollabDoc | null {
  const { user, refresh } = useSession()
  const userId = user.id
  const keepIn = options.workspaceId

  const latest = useRef({ options, refresh })
  useEffect(() => {
    latest.current = { options, refresh }
  })

  const [connection, setConnection] = useState<{ doc: Y.Doc; provider: HocuspocusProvider } | null>(null)
  const [ready, setReady] = useState(false)
  const [status, setStatus] = useState<ConnectionStatus>('connecting')
  const [scope, setScope] = useState<Scope | null>(null)
  const [noAccess, setNoAccess] = useState(false)

  useEffect(() => {
    let teardown: (() => void) | undefined
    const timer = window.setTimeout(() => {
      let alive = true
      let finished = false // the server has closed us for good
      let wire: ConnectionStatus = 'connecting'
      let authenticated = false

      const doc = new Y.Doc()
      const saved = keepIn ? new IndexeddbPersistence(localStoreName(userId, keepIn, docName), doc) : null
      const socket = new HocuspocusProviderWebsocket({ url: COLLAB_URL, delay: 500, minDelay: 500, maxDelay: 5000 })

      const publishStatus = () => {
        if (alive) setStatus(wire === 'connected' && !authenticated ? 'connecting' : wire)
      }

      const giveUp = () => {
        if (finished) return
        finished = true
        socket.disconnect()
        if (alive) setNoAccess(true)
        void saved?.clearData()
      }

      const provider = new HocuspocusProvider({
        name: docName,
        document: doc,
        websocketProvider: socket,
        token: async () => {
          try {
            return (await api.syncToken(docName)).token
          } catch (error) {
            if (alive && !finished) {
              if (error instanceof ApiError && error.status === 404) giveUp()
              else if (error instanceof ApiError && error.status === 401) socket.disconnect() // the app signs itself out
              else window.setTimeout(() => socket.webSocket?.close(), 0)
            }
            throw error
          }
        },
      })
      provider.attach()

      socket.on('status', ({ status: next }: { status: ConnectionStatus }) => {
        wire = next
        if (next !== 'connected') authenticated = false
        publishStatus()
      })
      provider.on('authenticated', ({ scope: granted }: { scope: Scope }) => {
        authenticated = true
        if (alive) setScope(granted)
        publishStatus()
        latest.current.options.onAuthenticated?.()
      })
      provider.on('stateless', ({ payload }: { payload: string }) => latest.current.options.onStateless?.(payload))
      socket.on('close', ({ event }: CloseInfo) => {
        if (!alive || finished) return
        if (event.code === CLOSE_CODES.forbidden) giveUp()
        // The session may have ended, or only the short-lived token ran out: find out which.
        else if (event.code === CLOSE_CODES.unauthorized) void latest.current.refresh()
        // Our role changed. We reconnect by ourselves; meanwhile re-read the roles shown on screen.
        else if (event.code === CLOSE_CODES.roleChanged) void latest.current.refresh()
      })

      const markReady = () => {
        if (alive) setReady(true)
      }
      provider.on('synced', markReady)
      if (provider.synced) markReady()
      void saved?.whenSynced.then(() => {
        if (Y.encodeStateAsUpdate(doc).length > 2) markReady()
      })
      const offlineTimer = window.setTimeout(() => {
        if (socket.status !== 'connected') markReady()
      }, 2000)
      const lastResortTimer = window.setTimeout(markReady, 10_000)

      setReady(false)
      setStatus('connecting')
      setScope(null)
      setNoAccess(false)
      setConnection({ doc, provider })

      teardown = () => {
        alive = false
        window.clearTimeout(offlineTimer)
        window.clearTimeout(lastResortTimer)
        provider.destroy()
        socket.destroy()
        void saved?.destroy()
      }
    }, 0)

    return () => {
      window.clearTimeout(timer)
      teardown?.()
    }
  }, [docName, userId, keepIn])

  return connection ? { ...connection, ready, status, scope, noAccess } : null
}
