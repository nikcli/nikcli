import "react-native-gesture-handler"
import "@/global.css"
import { useCallback, useEffect, useRef, useState } from "react"
import { Stack, router, usePathname, useRootNavigationState } from "expo-router"
import { StatusBar } from "expo-status-bar"
import { useColorScheme } from "nativewind"
import { GestureHandlerRootView } from "react-native-gesture-handler"
import { AppState, StyleSheet, View } from "react-native"
import { SafeAreaProvider } from "react-native-safe-area-context"
import { AppLockOverlay } from "@/components/AppLockOverlay"
import { GlobalErrorBoundary } from "@/components/GlobalErrorBoundary"
import { ToastHost } from "@/components/ui/ToastHost"
import { ServerProvider } from "@/lib/server-provider"
import { useServer } from "@/lib/server-context"
import { setupOfflineDrainOnForeground } from "@/lib/offline"
import {
  addNotificationNavigationListener,
  consumeInitialNotificationHref,
  reconcilePersistedLiveActivities,
} from "@/lib/notifications"
import { getAppPreferences } from "@/lib/storage"
import { useUIStore } from "@/lib/store"
import { ThemeProvider, useTheme } from "@/lib/theme"

let pendingNotificationHref: string | null = null

function AuthGuard() {
  const { config, ready, userToken, userLoading } = useServer()
  const pathname = usePathname()
  const rootNavigationState = useRootNavigationState()

  useEffect(() => {
    if (!rootNavigationState?.key) return
    if (!ready || userLoading) return
    if (!config) return // no server — index.tsx (connect screen) handles this
    // Don't redirect if already on login or connect screen
    if (pathname === "/login" || pathname === "/" || pathname === "" || pathname === "/connect") return
    // A pairing token is authentication too. Gating on the account token alone
    // bounced anyone who had paired with the QR but never signed in to a nikcli
    // account straight back to /login, from a session the host would have
    // served perfectly well.
    if (!userToken && !config.token) {
      router.replace("/login")
    }
  }, [ready, rootNavigationState?.key, userLoading, config, userToken, pathname])

  return null
}

function AppLockCoordinator() {
  const pathname = usePathname()
  const security = useUIStore((state) => state.security)
  const preferencesReady = useUIStore((state) => state.preferencesReady)
  const [locked, setLocked] = useState(false)
  const didBackground = useRef(false)
  const hasBeenActive = useRef(AppState.currentState === "active")

  const skipLock = pathname === "/" || pathname === "/login" || pathname === "/connect" || pathname === "" || !pathname

  useEffect(() => {
    if (!security.biometricsEnabled) setLocked(false)
  }, [security.biometricsEnabled])

  useEffect(() => {
    if (!preferencesReady) return

    const subscription = AppState.addEventListener("change", (next) => {
      if (next === "active") {
        hasBeenActive.current = true
        return
      }

      if (next !== "background" && next !== "inactive") return
      if (!hasBeenActive.current) return

      const latest = useUIStore.getState()
      if (!latest.preferencesReady) return
      if (!latest.security.biometricsEnabled || !latest.security.lockOnBackground) return
      if (skipLock) return

      didBackground.current = true
      setLocked(true)
    })

    return () => subscription.remove()
  }, [preferencesReady, skipLock])

  const onUnlocked = useCallback(() => setLocked(false), [])

  if (!preferencesReady || skipLock || !security.biometricsEnabled || !locked) return null

  return (
    <View pointerEvents="auto" style={[StyleSheet.absoluteFill, { zIndex: 20000 }]}>
      <AppLockOverlay onUnlocked={onUnlocked} />
    </View>
  )
}

function LiveActivityCoordinator() {
  const { client } = useServer()

  useEffect(() => {
    if (!client) return

    let active = true

    const reconcile = () => {
      if (!active) return

      void reconcilePersistedLiveActivities(async (sessionID) => {
        if (!active) return null

        try {
          return await client.getSession(sessionID)
        } catch {
          return null
        }
      })
    }

    reconcile()

    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") reconcile()
    })

    return () => {
      active = false
      subscription.remove()
    }
  }, [client])

  return null
}

function NotificationCoordinator() {
  const { config, ready, userToken, userLoading } = useServer()
  const rootNavigationState = useRootNavigationState()
  const authStateRef = useRef({
    config,
    ready,
    userToken,
    userLoading,
  })

  useEffect(() => {
    authStateRef.current = {
      config,
      ready,
      userToken,
      userLoading,
    }
  }, [config, ready, userLoading, userToken])

  useEffect(() => {
    let active = true

    const navigateToNotification = (href: string) => {
      if (!active || !href) return

      const authState = authStateRef.current
      if (
        !rootNavigationState?.key ||
        !authState.ready ||
        authState.userLoading ||
        !authState.config ||
        // Same rule as AuthGuard: either token is enough to be signed in. Held
        // to the account token, a notification tapped on a QR-paired phone was
        // parked in `pendingNotificationHref` and never opened.
        (!authState.userToken && !authState.config.token)
      ) {
        pendingNotificationHref = href
        return
      }

      pendingNotificationHref = null
      router.push(href as never)
    }

    void consumeInitialNotificationHref().then((href) => {
      if (href) navigateToNotification(href)
    })

    const cleanup = addNotificationNavigationListener(navigateToNotification)
    return () => {
      active = false
      cleanup()
    }
  }, [rootNavigationState?.key])

  useEffect(() => {
    if (!rootNavigationState?.key) return
    if (!pendingNotificationHref || !ready || userLoading || !config || !userToken) return

    const href = pendingNotificationHref
    pendingNotificationHref = null
    router.push(href as never)
  }, [config, ready, rootNavigationState?.key, userLoading, userToken])

  return null
}

export default function RootLayout() {
  const { setColorScheme } = useColorScheme()
  const hydratePreferences = useUIStore((state) => state.hydratePreferences)
  const themeMode = useUIStore((state) => state.themeMode)

  useEffect(() => {
    getAppPreferences()
      .then(hydratePreferences)
      .catch(() => undefined)
    return setupOfflineDrainOnForeground()
  }, [hydratePreferences])

  useEffect(() => {
    setColorScheme(themeMode)
  }, [setColorScheme, themeMode])

  return (
    <ThemeProvider>
      <RootLayoutInner />
    </ThemeProvider>
  )
}

function RootLayoutInner() {
  const { colorScheme, palette } = useTheme()

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <GlobalErrorBoundary>
          <ServerProvider>
            <AuthGuard />
            <NotificationCoordinator />
            <LiveActivityCoordinator />
            <StatusBar style={colorScheme === "light" ? "dark" : "light"} />
            <ToastHost />
            <Stack
              screenOptions={{
                headerStyle: { backgroundColor: palette.background },
                headerTintColor: palette.ink,
                headerShadowVisible: false,
                contentStyle: { backgroundColor: palette.background },
              }}
            >
              <Stack.Screen name="index" options={{ headerShown: false }} />
              <Stack.Screen
                name="connect"
                options={{
                  headerShown: false,
                  presentation: "fullScreenModal",
                  animation: "slide_from_bottom",
                  gestureEnabled: true,
                  contentStyle: { flex: 1, backgroundColor: palette.background },
                }}
              />
              <Stack.Screen
                name="login"
                options={{
                  headerShown: false,
                  presentation: "fullScreenModal",
                }}
              />
              <Stack.Screen name="(app)" options={{ headerShown: false }} />
              <Stack.Screen name="user" options={{ headerShown: false }} />
              <Stack.Screen name="+not-found" options={{ title: "Not found" }} />
            </Stack>
            <AppLockCoordinator />
          </ServerProvider>
        </GlobalErrorBoundary>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  )
}
