import { useCallback, useState } from 'react'
import { api } from '../api'
import { useRoute } from '../route'
import { useToast } from '../toast'

export function useStartDemo() {
  const { go } = useRoute()
  const toast = useToast()
  const [busy, setBusy] = useState(false)

  const start = useCallback(async () => {
    if (busy) return
    setBusy(true)
    try {
      const { ticket } = await api.startDemo()
      go({ name: 'demo', ticket, pageId: null })
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Could not start a demo. Please try again.', 'error')
    } finally {
      setBusy(false)
    }
  }, [busy, go, toast])

  return { start, busy }
}
