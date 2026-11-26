import { ApiError, api } from '../api'
import { useLiveDoc, type CollabDoc } from './useCollabDoc'

export function useDemoDoc(docName: string): CollabDoc | null {
  return useLiveDoc(docName, {
    fetchToken: async (name) => {
      try {
        return (await api.demoSyncToken(name)).token
      } catch (error) {
        if (error instanceof ApiError && error.status === 401) throw new ApiError(404, 'demo_ended', 'This demo has ended.')
        throw error
      }
    },
    localCopy: null,
  })
}
