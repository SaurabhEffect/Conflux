import { useCallback, useState } from 'react'

export function useAction() {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const run = useCallback(async <T>(task: () => Promise<T>): Promise<{ value: T } | null> => {
    setBusy(true)
    setError(null)
    try {
      return { value: await task() }
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : 'Something went wrong. Please try again.')
      return null
    } finally {
      setBusy(false)
    }
  }, [])

  return { busy, error, run, clearError: () => setError(null) }
}
