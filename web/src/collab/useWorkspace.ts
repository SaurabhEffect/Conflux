import { useCallback, useEffect, useState } from 'react'
import * as Y from 'yjs'
import type { Identity } from '../identity'
import { newId } from '../ids'
import { useCollabDoc } from './useCollabDoc'

export type PageMeta = {
  id: string
  title: string
  createdAt: number
}

export function useWorkspace(_identity: Identity) {
  const collab = useCollabDoc('workspace')
  const doc = collab?.doc ?? null
  const [pages, setPages] = useState<PageMeta[]>([])
  useEffect(() => {
    if (!doc) return
    const map = doc.getMap<Y.Map<unknown>>('pages')
    const refresh = () => setPages(readPages(map))
    refresh()
    map.observeDeep(refresh)
    return () => map.unobserveDeep(refresh)
  }, [doc])
  const createPage = useCallback(
    (title: string): string => {
      const id = newId()
      if (!doc) return id
      doc.transact(() => {
        const page = new Y.Map<unknown>()
        page.set('title', title)
        page.set('createdAt', Date.now())
        doc.getMap<Y.Map<unknown>>('pages').set(id, page)
      })
      return id
    },
    [doc],
  )

  const renamePage = useCallback(
    (id: string, title: string) => {
      doc?.getMap<Y.Map<unknown>>('pages').get(id)?.set('title', title)
    },
    [doc],
  )

  const deletePage = useCallback(
    (id: string) => {
      doc?.getMap<Y.Map<unknown>>('pages').delete(id)
    },
    [doc],
  )

  return {
    ready: collab?.ready ?? false,
    status: collab?.status ?? ('connecting' as const),
    provider: collab?.provider ?? null,
    pages,
    createPage,
    renamePage,
    deletePage,
  }
}

function readPages(map: Y.Map<Y.Map<unknown>>): PageMeta[] {
  const list: PageMeta[] = []
  map.forEach((page, id) => {
    if (!(page instanceof Y.Map)) return
    list.push({
      id,
      title: String(page.get('title') ?? ''),
      createdAt: Number(page.get('createdAt') ?? 0),
    })
  })
  return list.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
}
