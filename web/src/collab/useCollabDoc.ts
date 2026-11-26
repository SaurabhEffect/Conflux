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

export type LiveDocSource = {
  fetchToken: (docName: string) => Promise<string>
  localCopy: string | null
}

export type LiveDocOptions = {
  onStateless?: (payload: string) => void
  onAuthenticated?: () => void
  onTrouble?: () => void
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
  const localCopy = options.workspaceId ? localStoreName(user.id, options.workspaceId, docName) : null
  return useLiveDoc(
    docName,
    { fetchToken: async (name) => (await api.syncToken(name)).token, localCopy },
    { onStateless: options.onStateless, onAuthenticated: options.onAuthenticated, onTrouble: () => void refresh() },
  )
}

export function useLiveDoc(docName: string, source: LiveDocSource, options: LiveDocOptions = {}): CollabDoc | null {
  const keepIn = source.localCopy
  const latest = useRef({ options, source })
  useEffect(() => {
    latest.current = { options, source }
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
      const saved = keepIn ? new IndexeddbPersistence(keepIn, doc) : null
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
            return await latest.current.source.fetchToken(docName)
          } catch (error) {
            if (alive && !finished) {
              if (error instanceof ApiError && error.status === 404) giveUp()
              else if (error instanceof ApiError && error.status === 401) socket.disconnect() // the app signs itself out
              // Network or server trouble: drop this attempt so the connection is retried with a fresh token.
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
        if (event.code === CLOSE_CODES.forbidden || event.code === CLOSE_CODES.demoEnded) giveUp()
        else if (event.code === CLOSE_CODES.unauthorized) latest.current.options.onTrouble?.()
        else if (event.code === CLOSE_CODES.roleChanged) latest.current.options.onTrouble?.()
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
  }, [docName, keepIn])

  return connection ? { ...connection, ready, status, scope, noAccess } : null
}
