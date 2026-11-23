import type { SignupResponse, UserDto, WorkspaceDto } from '@conflux/shared'
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { ApiError, api, setSessionEndedHandler } from './api'
import { forgetOrphanedCopies, wipeLocalCopies } from './collab/localStore'

export type AuthState =
  | { status: 'loading' }
  | { status: 'unreachable'; message: string }
  | { status: 'signedOut'; notice: string | null }
  | { status: 'signedIn'; user: UserDto; workspaces: WorkspaceDto[] }

type AuthApi = {
  state: AuthState
  signup: (input: { email: string; password: string; displayName: string }) => Promise<SignupResponse>
  login: (input: { email: string; password: string }) => Promise<void>
  logout: () => Promise<void>
  refresh: () => Promise<void>
  retry: () => void
  rename: (displayName: string) => Promise<void>
  addWorkspace: (workspace: WorkspaceDto) => void
}

const AuthContext = createContext<AuthApi | null>(null)
const SESSION_ENDED = 'Your session ended. Please sign in again.'
const tidyLocalCopies = (me: { user: UserDto; workspaces: WorkspaceDto[] }) =>
  void forgetOrphanedCopies(
    me.user.id,
    me.workspaces.map((workspace) => workspace.id),
  )

const sameAccount = (a: { user: UserDto; workspaces: WorkspaceDto[] }, b: { user: UserDto; workspaces: WorkspaceDto[] }) =>
  JSON.stringify(a) === JSON.stringify(b)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>({ status: 'loading' })

  const endSession = useCallback(() => {
    setState((current) => (current.status === 'signedIn' ? { status: 'signedOut', notice: SESSION_ENDED } : current))
  }, [])

  const load = useCallback(async () => {
    setState({ status: 'loading' })
    try {
      const me = await api.me()
      setState({ status: 'signedIn', user: me.user, workspaces: me.workspaces })
      tidyLocalCopies(me)
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) setState({ status: 'signedOut', notice: null })
      else setState({ status: 'unreachable', message: error instanceof Error ? error.message : 'Cannot reach the server.' })
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    setSessionEndedHandler(endSession)
    return () => setSessionEndedHandler(null)
  }, [endSession])

  const refresh = useCallback(async () => {
    try {
      const me = await api.me()
      setState((current) =>
        current.status === 'signedIn' && !sameAccount(current, me) ? { status: 'signedIn', user: me.user, workspaces: me.workspaces } : current,
      )
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) endSession()
    }
  }, [endSession])

  const value = useMemo<AuthApi>(
    () => ({
      state,
      refresh,
      retry: () => void load(),
      async signup(input) {
        const created = await api.signup(input)
        setState({ status: 'signedIn', user: created.user, workspaces: created.workspaces })
        return created
      },
      async login(input) {
        const me = await api.login(input)
        setState({ status: 'signedIn', user: me.user, workspaces: me.workspaces })
        tidyLocalCopies(me)
      },
      async logout() {
        try {
          await api.logout()
        } catch (error) {
          // Could not reach the server: stay signed in rather than pretend we left.
          if (!(error instanceof ApiError) || error.status !== 401) throw error
        }
        setState({ status: 'signedOut', notice: null })
        void wipeLocalCopies()
      },
      async rename(displayName) {
        const me = await api.updateMe(displayName)
        setState((current) => (current.status === 'signedIn' ? { status: 'signedIn', user: me.user, workspaces: me.workspaces } : current))
      },
      addWorkspace(workspace) {
        setState((current) =>
          current.status === 'signedIn' && !current.workspaces.some((item) => item.id === workspace.id)
            ? { ...current, workspaces: [...current.workspaces, workspace] }
            : current,
        )
      },
    }),
    [state, refresh, load],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth(): AuthApi {
  const value = useContext(AuthContext)
  if (!value) throw new Error('useAuth needs <AuthProvider>')
  return value
}

export function useSession() {
  const auth = useAuth()
  if (auth.state.status !== 'signedIn') throw new Error('useSession was used while signed out')
  return {
    user: auth.state.user,
    workspaces: auth.state.workspaces,
    refresh: auth.refresh,
    logout: auth.logout,
    rename: auth.rename,
    addWorkspace: auth.addWorkspace,
  }
}
