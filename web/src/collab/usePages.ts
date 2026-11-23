import type { PageDto } from '@conflux/shared'
import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../api'

type Options = { onError?: (message: string) => void }

const RENAME_DELAY_MS = 600
const RELOAD_DELAY_MS = 120

export function usePages(workspaceId: string, options: Options = {}) {
  const [pages, setPages] = useState<PageDto[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)

  const alive = useRef(true)
  const latestRequest = useRef(0)
  const reloadTimer = useRef<number | null>(null)
  const renameTimers = useRef(new Map<string, number>())
  const unsaved = useRef(new Map<string, string>())
  const onError = useRef(options.onError)
  useEffect(() => {
    onError.current = options.onError
  })

  const show = useCallback((list: PageDto[]) => {
    setPages(list.map((page) => (unsaved.current.has(page.id) ? { ...page, title: unsaved.current.get(page.id) ?? page.title } : page)))
  }, [])

  const load = useCallback(async () => {
    const ticket = ++latestRequest.current
    try {
      const { pages: list } = await api.pages(workspaceId)
      if (!alive.current || ticket !== latestRequest.current) return // a newer answer is on its way
      setLoadError(null)
      show(list)
    } catch (error) {
      if (!alive.current || ticket !== latestRequest.current) return
      setLoadError(error instanceof Error ? error.message : 'Could not load the pages.')
    }
  }, [workspaceId, show])

  const reload = useCallback(() => {
    if (reloadTimer.current !== null) return
    reloadTimer.current = window.setTimeout(() => {
      reloadTimer.current = null
      void load()
    }, RELOAD_DELAY_MS)
  }, [load])

  const sendRename = useCallback(
    async (id: string) => {
      renameTimers.current.delete(id)
      const title = unsaved.current.get(id)
      if (title === undefined) return
      try {
        const saved = await api.renamePage(id, title)
        if (unsaved.current.get(id) !== title) return // typed more in the meantime; that change is already queued
        unsaved.current.delete(id)
        if (alive.current) setPages((list) => list?.map((page) => (page.id === id ? saved : page)) ?? null)
      } catch (error) {
        unsaved.current.delete(id)
        if (alive.current) {
          onError.current?.(error instanceof Error ? error.message : 'Could not rename the page.')
          void load() // put the real title back
        }
      }
    },
    [load],
  )

  useEffect(() => {
    alive.current = true
    void load()
    const again = () => {
      if (document.visibilityState === 'visible') reload()
    }
    window.addEventListener('focus', again)
    document.addEventListener('visibilitychange', again)
    const timers = renameTimers.current
    return () => {
      alive.current = false
      window.removeEventListener('focus', again)
      document.removeEventListener('visibilitychange', again)
      if (reloadTimer.current !== null) window.clearTimeout(reloadTimer.current)
      reloadTimer.current = null
      for (const [id, timer] of timers) {
        window.clearTimeout(timer)
        void sendRename(id)
      }
    }
  }, [load, reload, sendRename])

  const create = useCallback(
    async (title = '') => {
      const page = await api.createPage(workspaceId, title)
      setPages((list) => (list ? (list.some((item) => item.id === page.id) ? list : [...list, page]) : [page]))
      return page
    },
    [workspaceId],
  )

  const rename = useCallback(
    (id: string, title: string) => {
      unsaved.current.set(id, title)
      setPages((list) => list?.map((page) => (page.id === id ? { ...page, title } : page)) ?? null)
      const waiting = renameTimers.current.get(id)
      if (waiting !== undefined) window.clearTimeout(waiting)
      renameTimers.current.set(id, window.setTimeout(() => void sendRename(id), RENAME_DELAY_MS))
    },
    [sendRename],
  )

  const remove = useCallback(async (id: string) => {
    await api.deletePage(id)
    const waiting = renameTimers.current.get(id)
    if (waiting !== undefined) window.clearTimeout(waiting)
    renameTimers.current.delete(id)
    unsaved.current.delete(id)
    setPages((list) => list?.filter((page) => page.id !== id) ?? null)
  }, [])

  return { pages, loadError, reload, retry: load, create, rename, remove }
}
