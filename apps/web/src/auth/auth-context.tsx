import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'

import { ApiClientError } from '../lib/api-client.js'
import {
  isPlatformUser,
  restoreSession,
  signIn,
  signOut as signOutRequest,
  type SessionUser,
} from './session.js'
import { tokenStore } from './token-store.js'

/**
 * Authentication state for the whole application.
 *
 * Three states, not two. `restoring` exists because the durable credential is an
 * `HttpOnly` refresh cookie: on a page reload the access token is gone (it lives only
 * in memory) and must be re-obtained. Rendering the sign-in screen during that window
 * would flash a login form at a user who is already signed in, and would race their
 * real sign-in. Guards therefore wait for `restoring` to finish instead of redirecting
 * immediately.
 */
export type AuthStatus = 'restoring' | 'authenticated' | 'anonymous'

export interface AuthContextValue {
  status: AuthStatus
  user: SessionUser | null
  isPlatform: boolean
  signIn: (input: { email: string; password: string }) => Promise<SessionUser>
  signOut: () => Promise<void>
  /** Clears local state without calling the API — used when the server rejects a session. */
  invalidate: () => void
}

const AuthContext = createContext<AuthContextValue | null>(null)

export function AuthProvider({
  children,
  /** Test seam: skip the bootstrap refresh call. */
  autoRestore = true,
}: {
  children: ReactNode
  autoRestore?: boolean
}) {
  const [status, setStatus] = useState<AuthStatus>(autoRestore ? 'restoring' : 'anonymous')
  const [user, setUser] = useState<SessionUser | null>(null)
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  useEffect(() => {
    if (!autoRestore) return

    let cancelled = false

    void (async () => {
      try {
        const result = await restoreSession()
        if (cancelled) return
        tokenStore.set(result.accessToken)
        setUser(result.user)
        setStatus('authenticated')
      } catch {
        // Expected for a first-time visitor: no refresh cookie exists, or the family was
        // revoked. Either way the correct outcome is "not signed in" — never an error
        // banner, because nobody asked for anything.
        if (cancelled) return
        tokenStore.clear()
        setUser(null)
        setStatus('anonymous')
      }
    })()

    return () => {
      cancelled = true
    }
  }, [autoRestore])

  const signInWithCredentials = useCallback(async (input: { email: string; password: string }) => {
    const result = await signIn(input)
    tokenStore.set(result.accessToken)
    setUser(result.user)
    setStatus('authenticated')
    return result.user
  }, [])

  const clearLocalSession = useCallback(() => {
    tokenStore.clear()
    setUser(null)
    setStatus('anonymous')
  }, [])

  const signOut = useCallback(async () => {
    try {
      await signOutRequest()
    } catch (error) {
      // A failed sign-out must still clear the client. Leaving someone "signed in"
      // because the network was down is worse than a stale cookie the server will
      // reject on next use.
      if (!(error instanceof ApiClientError)) throw error
    } finally {
      clearLocalSession()
    }
  }, [clearLocalSession])

  const value = useMemo<AuthContextValue>(
    () => ({
      status,
      user,
      isPlatform: user !== null && isPlatformUser(user),
      signIn: signInWithCredentials,
      signOut,
      invalidate: clearLocalSession,
    }),
    [status, user, signInWithCredentials, signOut, clearLocalSession],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext)
  if (context === null) {
    throw new Error('useAuth must be used inside an <AuthProvider>')
  }
  return context
}
