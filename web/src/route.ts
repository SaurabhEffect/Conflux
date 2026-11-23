import { UUID_PATTERN } from '@conflux/shared'
import { useCallback, useMemo, useSyncExternalStore } from 'react'

export type Route =
  | { name: 'home' }
  | { name: 'workspace'; workspaceId: string }
  | { name: 'page'; workspaceId: string; pageId: string }
  | { name: 'join'; token: string }

const PAGE_RE = new RegExp(`^#/w/(${UUID_PATTERN})/p/(${UUID_PATTERN})/?$`)
const WORKSPACE_RE = new RegExp(`^#/w/(${UUID_PATTERN})/?$`)
const JOIN_RE = /^#\/join\/([^/?#]*)$/

export function parseRoute(hash: string): Route {
  const page = PAGE_RE.exec(hash)
  if (page) return { name: 'page', workspaceId: page[1], pageId: page[2] }
  const workspace = WORKSPACE_RE.exec(hash)
  if (workspace) return { name: 'workspace', workspaceId: workspace[1] }
  const join = JOIN_RE.exec(hash)
  if (join) return { name: 'join', token: join[1] }
  return { name: 'home' }
}

export function hrefFor(route: Route): string {
  switch (route.name) {
    case 'home':
      return '#/'
    case 'workspace':
      return `#/w/${route.workspaceId}`
    case 'page':
      return `#/w/${route.workspaceId}/p/${route.pageId}`
    case 'join':
      return `#/join/${route.token}`
  }
}

const listeners = new Set<() => void>()
const notify = () => listeners.forEach((listener) => listener())

function subscribe(listener: () => void) {
  listeners.add(listener)
  window.addEventListener('hashchange', listener)
  return () => {
    listeners.delete(listener)
    window.removeEventListener('hashchange', listener)
  }
}

const currentHash = () => window.location.hash

export function useRoute() {
  const hash = useSyncExternalStore(subscribe, currentHash)
  const go = useCallback((route: Route, options: { replace?: boolean } = {}) => {
    const target = hrefFor(route)
    if (options.replace) {
      window.history.replaceState(null, '', target)
      notify() // replaceState does not fire "hashchange" on its own
    } else {
      window.location.hash = target
    }
  }, [])
  const route = useMemo(() => parseRoute(hash), [hash])
  return { route, go }
}
