import { useCallback, useEffect, useMemo, useRef, useState, type PropsWithChildren } from "react"
import { AppState } from "react-native"
import {
  clearServerConfig,
  getServerConfig,
  setServerConfig,
  getUserToken,
  setUserToken,
  clearUserToken,
  getOAuthTokens,
} from "@/lib/storage"
import { MobileClient, MobileResponseError } from "@/lib/client"
import { getValidOAuthTokens, revokeOAuthSession } from "@/lib/oauth"
import type { OAuthTokenTriple } from "@/lib/oauth-core"
import type { MobileBootstrap, ServerConfig } from "@/lib/types"
import { ServerContext, type ServerContextValue, userLogoutApi, userMe, type UserProfile } from "@/lib/server-context"

export function ServerProvider(props: PropsWithChildren) {
  const [config, setConfig] = useState<ServerConfig | null>(null)
  const [loading, setLoading] = useState(true)
  const [bootstrap, setBootstrap] = useState<MobileBootstrap | null>(null)
  const [bootstrapLoading, setBootstrapLoading] = useState(false)
  const [currentUser, setCurrentUser] = useState<UserProfile | null>(null)
  const [userToken, setUserTokenState] = useState<string | null>(null)
  const [userLoading, setUserLoading] = useState(true)
  const [connectivity, setConnectivity] = useState<ServerContextValue["connectivity"]>("disconnected")
  const [connectionError, setConnectionError] = useState<string | null>(null)
  const generation = useRef(0)
  const currentClient = useRef(clientPlaceholder())

  function clientPlaceholder(): MobileClient | null {
    return null
  }

  const refreshOAuth = useCallback(async (force: boolean): Promise<string | null> => {
    const version = generation.current
    const tokens = await getValidOAuthTokens(force)
    if (!tokens || version !== generation.current) return null
    setUserTokenState(tokens.access)
    return tokens.access
  }, [])

  const client = useMemo(
    () =>
      config
        ? new MobileClient(
            { ...config, token: userToken ?? config.token },
            { onUnauthorized: () => refreshOAuth(true), fallbackToken: config.token },
          )
        : null,
    [config, refreshOAuth, userToken],
  )
  currentClient.current = client

  useEffect(() => {
    let mounted = true
    Promise.all([getServerConfig(), getOAuthTokens(), getUserToken()])
      .then(([cfg, oauth, legacyToken]) => {
        if (!mounted) return
        setConfig(cfg)
        const token = oauth?.access ?? legacyToken
        if (token && cfg) {
          setUserTokenState(token)
          userMe(cfg.url, token, () => refreshOAuth(true))
            .then((user) => {
              if (mounted) setCurrentUser(user)
            })
            .catch((error: unknown) => {
              if (mounted && error instanceof MobileResponseError && error.status === 401) {
                setUserTokenState(null)
                setCurrentUser(null)
                void clearUserToken().catch(() => undefined)
              }
            })
            .finally(() => {
              if (mounted) setUserLoading(false)
            })
        } else {
          setUserLoading(false)
        }
      })
      .catch((error: unknown) => {
        if (!mounted) return
        setConnectionError(error instanceof Error ? error.message : "Unable to read saved connection")
        setUserLoading(false)
      })
      .finally(() => {
        if (mounted) setLoading(false)
      })
    return () => {
      mounted = false
      generation.current++
    }
  }, [refreshOAuth])

  useEffect(() => {
    let active = true
    const subscription = AppState.addEventListener("change", (state) => {
      if (state !== "active") return
      void refreshOAuth(false)
        .then((token) => {
          if (!active || !token || !config) return
          void userMe(config.url, token)
            .then((user) => {
              if (active) setCurrentUser(user)
            })
            .catch(() => undefined)
        })
        .catch(() => undefined)
    })
    return () => {
      active = false
      subscription.remove()
    }
  }, [config, refreshOAuth])

  useEffect(() => {
    if (!config || !client) {
      setBootstrap(null)
      setBootstrapLoading(false)
      setConnectivity("disconnected")
      setConnectionError(null)
      return
    }

    let mounted = true
    let controller: AbortController | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    let failures = 0
    const stop = () => {
      controller?.abort()
      controller = undefined
      clearTimeout(timer)
    }
    const probe = async () => {
      stop()
      if (!mounted || (AppState.currentState && AppState.currentState !== "active")) return
      const attempt = new AbortController()
      controller = attempt
      setBootstrapLoading(true)
      setConnectivity("connecting")
      try {
        const value = await client.request<MobileBootstrap>("/mobile/bootstrap", { signal: attempt.signal })
        if (!mounted || attempt.signal.aborted) return
        failures = 0
        setBootstrap(value)
        setConnectivity("online")
        setConnectionError(null)
      } catch (error) {
        if (!mounted || attempt.signal.aborted) return
        failures++
        setConnectivity(
          error instanceof MobileResponseError
            ? error.status === 401 || error.status === 403
              ? "auth-required"
              : "error"
            : "offline",
        )
        setConnectionError(error instanceof Error ? error.message : "Connection failed")
      } finally {
        if (mounted && !attempt.signal.aborted) {
          setBootstrapLoading(false)
          timer = setTimeout(
            () => void probe(),
            failures ? Math.min(30_000, 1000 * 2 ** Math.min(failures, 5)) : 30_000,
          )
        }
      }
    }
    setBootstrap(null)
    void probe()
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") void probe()
      else {
        stop()
        setBootstrapLoading(false)
        setConnectivity("background")
      }
    })
    return () => {
      mounted = false
      stop()
      subscription.remove()
    }
  }, [config, client])

  const value = useMemo<ServerContextValue>(
    () => ({
      config,
      loading,
      ready: !loading,
      connectivity,
      connectionError,
      client,
      bootstrap,
      bootstrapLoading,
      currentUser,
      userToken,
      userLoading,
      async refreshBootstrap() {
        if (!config || !client) {
          setBootstrap(null)
          setBootstrapLoading(false)
          return null
        }
        setBootstrapLoading(true)
        try {
          const next = await client.bootstrap()
          if (currentClient.current !== client) return null
          setBootstrap(next)
          setConnectivity("online")
          setConnectionError(null)
          return next
        } catch (error) {
          if (currentClient.current === client) {
            setConnectivity(
              error instanceof MobileResponseError
                ? error.status === 401 || error.status === 403
                  ? "auth-required"
                  : "error"
                : "offline",
            )
            setConnectionError(error instanceof Error ? error.message : "Connection failed")
          }
          throw error
        } finally {
          if (currentClient.current === client) setBootstrapLoading(false)
        }
      },
      async save(next: ServerConfig) {
        await setServerConfig(next)
        generation.current++
        setConfig(next)
      },
      async clear() {
        await clearServerConfig()
        generation.current++
        setConfig(null)
        setBootstrap(null)
      },
      async setUserSession(token: string, user: UserProfile) {
        await setUserToken(token)
        generation.current++
        setUserTokenState(token)
        setCurrentUser(user)
      },
      async setOAuthSession(tokens: OAuthTokenTriple, user: UserProfile) {
        generation.current++
        setUserTokenState(tokens.access)
        setCurrentUser(user)
      },
      async signOut() {
        generation.current++
        await revokeOAuthSession().catch(() => undefined)
        if (userToken && config) await userLogoutApi(config.url, userToken).catch(() => undefined)
        await clearUserToken()
        setUserTokenState(null)
        setCurrentUser(null)
      },
    }),
    [
      bootstrap,
      bootstrapLoading,
      client,
      config,
      currentUser,
      loading,
      userLoading,
      userToken,
      connectivity,
      connectionError,
    ],
  )

  return <ServerContext.Provider value={value}>{props.children}</ServerContext.Provider>
}
