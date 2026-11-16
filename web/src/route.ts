import { useCallback, useEffect, useState } from 'react'
export function useHashRoute() {
  const [hash, setHash] = useState(() => window.location.hash)
  useEffect(() => {
    const onChange = () => setHash(window.location.hash)
    window.addEventListener('hashchange', onChange)
    return () => window.removeEventListener('hashchange', onChange)
  }, [])
  const match = /^#\/p\/([a-z0-9]+)$/.exec(hash)
  const pageId = match ? match[1] : null
  const go = useCallback((id: string | null, options: { replace?: boolean } = {}) => {
    const target = id ? `#/p/${id}` : '#/'
    if (options.replace) {
      window.history.replaceState(null, '', target)
      setHash(target)
    }
    else {
      window.location.hash = target
    }
  }, [])
  return { pageId, go }
}
