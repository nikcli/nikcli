import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Linking,
  Modal,
  Platform,
  ScrollView,
  Text,
  View,
} from "react-native"
import { CameraView, useCameraPermissions } from "expo-camera"
import * as Clipboard from "expo-clipboard"
import { router, useRootNavigationState } from "expo-router"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import { ChevronLeft, X } from "lucide-react-native"
import { BrandMark } from "@/components/layout/BrandMark"
import { CenteredScreenHeader } from "@/components/layout/CenteredScreenHeader"
import { ActionButton } from "@/components/ui/ActionButton"
import { ErrorBanner } from "@/components/ui/ErrorBanner"
import { IconCircleButton } from "@/components/ui/IconCircleButton"
import { SurfaceCard } from "@/components/ui/SurfaceCard"
import { TextField } from "@/components/ui/TextField"
import { MobileClient } from "@/lib/client"
import { triggerHaptic } from "@/lib/haptics"
import { parsePairingPayload } from "@/lib/pairing"
import { useServer, userStatus } from "@/lib/server-context"
import { useUIStore } from "@/lib/store"
import { hexToRgba, useAppTheme } from "@/lib/theme"
import { mono, type as typeStyle } from "@/lib/typography"
import type { ServerConfig } from "@/lib/types"

export type ConnectMode = "landing" | "pair" | "add"

function nextRouteAfterConnect(userToken: string | null, mobileToken?: string) {
  return userToken || mobileToken ? "/sessions" : "/login"
}

function HowToStep({ index, title, detail }: { index: number; title: string; detail: string }) {
  const { palette } = useAppTheme()
  return (
    <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 12 }}>
      <View
        style={{
          width: 28,
          height: 28,
          borderRadius: 14,
          backgroundColor: hexToRgba(palette.ink, 0.08),
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <Text
          style={{
            color: palette.ink,
            fontVariant: ["tabular-nums"],
            ...typeStyle(13, { weight: "700" }),
          }}
        >
          {index}
        </Text>
      </View>
      <View style={{ flex: 1, gap: 2, paddingTop: 2 }}>
        <Text style={{ color: palette.ink, ...typeStyle(15, { weight: "600" }) }}>{title}</Text>
        <Text selectable style={{ color: palette.muted, ...typeStyle(13) }}>
          {detail}
        </Text>
      </View>
    </View>
  )
}

function PairingScanner({ onClose, onScanned }: { onClose(): void; onScanned(payload: ServerConfig): void }) {
  const { top, bottom } = useSafeAreaInsets()
  const [permission, requestPermission] = useCameraPermissions()
  const [hint, setHint] = useState("Point the camera at the QR on your computer")
  const lock = useRef(false)

  useEffect(() => {
    lock.current = false
    if (!permission || permission.granted || !permission.canAskAgain) return
    void requestPermission()
  }, [permission, requestPermission])

  return (
    <Modal animationType="fade" presentationStyle="fullScreen" onRequestClose={onClose} visible>
      <View style={{ flex: 1, backgroundColor: "#000" }}>
        {permission?.granted ? (
          <CameraView
            facing="back"
            style={{ flex: 1 }}
            barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
            onBarcodeScanned={(result) => {
              if (lock.current) return
              const parsed = parsePairingPayload(result.data)
              if (!parsed) {
                lock.current = true
                setHint("This is not a nikcli pairing QR. Use the code from your computer.")
                void triggerHaptic("error")
                setTimeout(() => {
                  lock.current = false
                }, 1600)
                return
              }
              lock.current = true
              void triggerHaptic("success")
              onScanned(parsed)
            }}
          />
        ) : (
          <View
            style={{
              flex: 1,
              justifyContent: "center",
              paddingHorizontal: 28,
              gap: 16,
            }}
          >
            <Text
              style={{
                color: "#fff",
                textAlign: "center",
                ...typeStyle(22, { weight: "700" }),
              }}
            >
              Camera access
            </Text>
            <Text
              style={{
                color: "rgba(255,255,255,0.72)",
                textAlign: "center",
                ...typeStyle(15),
              }}
            >
              Allow the camera so this phone can read the pairing QR shown by nikcli on your computer.
            </Text>
            <ActionButton
              label={permission && !permission.canAskAgain ? "Open Settings" : "Allow camera"}
              onPress={() => {
                if (permission && !permission.canAskAgain) {
                  void Linking.openSettings()
                  return
                }
                void requestPermission()
              }}
            />
          </View>
        )}

        <View
          pointerEvents="box-none"
          style={{
            position: "absolute",
            top: 0,
            right: 0,
            bottom: 0,
            left: 0,
            paddingTop: top + 12,
            paddingBottom: bottom + 24,
            paddingHorizontal: 20,
            justifyContent: "space-between",
          }}
        >
          <View style={{ flexDirection: "row", justifyContent: "flex-end" }}>
            <IconCircleButton size={44} tone="inverse" accessibilityLabel="Close scanner" onPress={onClose}>
              <X size={20} color="#fff" strokeWidth={2} />
            </IconCircleButton>
          </View>

          {permission?.granted ? (
            <View style={{ alignItems: "center", gap: 24 }}>
              <View
                style={{
                  width: 236,
                  height: 236,
                  borderRadius: 28,
                  borderCurve: "continuous",
                  borderWidth: 3,
                  borderColor: "rgba(255,255,255,0.88)",
                }}
              />
              <Text
                style={{
                  color: "#fff",
                  textAlign: "center",
                  maxWidth: 280,
                  ...typeStyle(15, { weight: "600" }),
                }}
              >
                {hint}
              </Text>
            </View>
          ) : (
            <View />
          )}

          <View />
        </View>
      </View>
    </Modal>
  )
}

export function ConnectScreen({ mode }: { mode: ConnectMode }) {
  const { palette } = useAppTheme()
  const { top, bottom } = useSafeAreaInsets()
  const { config, loading, ready, save, userToken } = useServer()
  const rootNavigationState = useRootNavigationState()
  const isEditor = mode !== "landing"
  const isAddDevice = mode === "add"
  const [url, setUrl] = useState("")
  const [token, setToken] = useState("")
  const [directory, setDirectory] = useState("")
  const [testing, setTesting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [scanning, setScanning] = useState(false)
  const [showManual, setShowManual] = useState(isEditor)
  const [launchUrlReady, setLaunchUrlReady] = useState(false)
  const [incoming, setIncoming] = useState<ServerConfig | null>(null)
  const incomingApplied = useRef<ServerConfig | null>(null)
  const hydrated = useRef(false)
  const scrollRef = useRef<ScrollView>(null)

  const form = useMemo(
    () => ({
      url: url.trim(),
      token: token.trim() || undefined,
      directory: directory.trim() || undefined,
    }),
    [directory, token, url],
  )

  const applyPairing = useCallback((payload: ServerConfig) => {
    setUrl(payload.url)
    setToken(payload.token ?? "")
    setDirectory(payload.directory ?? "")
    setShowManual(true)
    setError(null)
  }, [])

  const connectWith = useCallback(
    async (payload: ServerConfig) => {
      if (!payload.url) {
        setError("Server URL is required")
        setShowManual(true)
        return
      }
      try {
        setTesting(true)
        setError(null)
        if (payload.token) await new MobileClient(payload).bootstrap()
        else await userStatus(payload.url)
        await save({
          ...config,
          ...payload,
        })
        void triggerHaptic("success")
        if (rootNavigationState?.key) router.replace(nextRouteAfterConnect(userToken, payload.token))
      } catch (nextError) {
        setShowManual(true)
        setError(nextError instanceof Error ? nextError.message : String(nextError))
        void triggerHaptic("error")
      } finally {
        setTesting(false)
      }
    },
    [config, rootNavigationState?.key, save, userToken],
  )

  useEffect(() => {
    if (hydrated.current || loading) return
    hydrated.current = true
    if (isAddDevice) {
      setShowManual(true)
      return
    }
    if (!config) return
    setUrl(config.url)
    setToken(config.token ?? "")
    setDirectory(config.directory ?? "")
    if (isEditor) setShowManual(true)
  }, [config, isAddDevice, isEditor, loading])

  useEffect(() => {
    let mounted = true

    void Linking.getInitialURL()
      .then((value) => {
        if (!mounted) return
        const parsed = value ? parsePairingPayload(value) : null
        if (parsed && !isEditor) setIncoming(parsed)
        setLaunchUrlReady(true)
      })
      .catch(() => {
        if (mounted) setLaunchUrlReady(true)
      })

    const subscription = Linking.addEventListener("url", ({ url: nextUrl }) => {
      const parsed = parsePairingPayload(nextUrl)
      if (!parsed) return
      applyPairing(parsed)
      if (!isEditor) setIncoming(parsed)
    })

    return () => {
      mounted = false
      subscription.remove()
    }
  }, [applyPairing, isEditor])

  useEffect(() => {
    if (!incoming || isEditor) return
    applyPairing(incoming)
    if (!ready || !rootNavigationState?.key) return
    if (incomingApplied.current === incoming) return
    incomingApplied.current = incoming
    void connectWith(incoming)
  }, [applyPairing, connectWith, incoming, isEditor, ready, rootNavigationState?.key])

  useEffect(() => {
    if (isEditor) return
    if (!rootNavigationState?.key || !ready || !launchUrlReady) return
    if (incoming) return
    if (!config) return

    let cancelled = false
    const auth = userToken ? { ...config, token: userToken } : config
    const check = userToken || config.token ? new MobileClient(auth).ping() : userStatus(config.url).then(() => true)
    void check.then((ok) => {
      if (!cancelled && ok) router.replace(nextRouteAfterConnect(userToken, config.token))
    })

    return () => {
      cancelled = true
    }
  }, [config, incoming, isEditor, launchUrlReady, ready, rootNavigationState?.key, userToken])

  function handleUrlChange(value: string) {
    if (value.includes("nikcli://")) {
      const parsed = parsePairingPayload(value)
      if (parsed) {
        applyPairing(parsed)
        return
      }
    }
    setUrl(value)
  }

  function filledFromPayload(payload: ServerConfig) {
    applyPairing(payload)
    if (!isEditor) {
      void connectWith(payload)
      return
    }
    requestAnimationFrame(() => scrollRef.current?.scrollToEnd({ animated: true }))
    useUIStore.getState().showToast({
      message: "Check the details below, then continue.",
      kind: "success",
    })
  }

  async function pastePairingLink() {
    void triggerHaptic("selection")
    const text = await Clipboard.getStringAsync().catch(() => "")
    const parsed = parsePairingPayload(text)
    if (!parsed) {
      setError("Copy the pairing link from nikcli on your computer, then paste it here.")
      setShowManual(true)
      void triggerHaptic("error")
      return
    }
    filledFromPayload(parsed)
  }

  function openScanner() {
    if (process.env.EXPO_OS === "web") {
      Alert.alert(
        "Scan on a phone",
        "QR scanning runs on iOS and Android. Paste the pairing link from your computer instead.",
      )
      return
    }
    void triggerHaptic("selection")
    setError(null)
    setScanning(true)
  }

  function signInWithAccount() {
    void triggerHaptic("selection")
    if (!form.url) {
      setShowManual(true)
      setError("Enter the server URL from your computer, then sign in.")
      return
    }
    void connectWith({ url: form.url, directory: form.directory })
  }

  function closeEditor() {
    void triggerHaptic("selection")
    if (router.canGoBack()) router.back()
    else router.replace("/sessions")
  }

  if (loading && !config && !isEditor) {
    return (
      <View
        style={{
          flex: 1,
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: palette.background,
        }}
      >
        <ActivityIndicator color={palette.accent} />
      </View>
    )
  }

  const title = isAddDevice ? "Add device" : "Connect"

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      style={{ flex: 1, backgroundColor: palette.background }}
    >
      <ScrollView
        ref={scrollRef}
        style={{ flex: 1, backgroundColor: palette.background }}
        contentInsetAdjustmentBehavior="automatic"
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{
          flexGrow: 1,
          paddingHorizontal: 20,
          paddingTop: isEditor ? 10 : top + 16,
          paddingBottom: bottom + 28,
          gap: 18,
        }}
      >
        {isEditor ? (
          <View style={{ gap: 8 }}>
            <CenteredScreenHeader
              title={title}
              left={
                <IconCircleButton size={44} accessibilityLabel="Cancel" onPress={closeEditor}>
                  <ChevronLeft size={20} color={palette.ink} strokeWidth={2} />
                </IconCircleButton>
              }
            />
            <Text
              style={{
                color: palette.muted,
                paddingHorizontal: 4,
                ...typeStyle(15),
              }}
            >
              {isAddDevice
                ? "Scan a QR or type the host. Nothing is saved until you continue."
                : "Scan the QR nikcli shows on your computer, then confirm the details."}
            </Text>
          </View>
        ) : (
          <View style={{ gap: 10, paddingHorizontal: 4, paddingTop: 4 }}>
            <BrandMark />
            <Text
              accessibilityRole="header"
              style={{
                color: palette.ink,
                ...typeStyle(34, { weight: "700" }),
              }}
            >
              Connect
            </Text>
            <Text style={{ color: palette.muted, ...typeStyle(16) }}>
              Scan the QR that nikcli shows on your computer. Same Wi-Fi, then this phone is paired.
            </Text>
          </View>
        )}

        {mode === "landing" ? (
          <SurfaceCard
            eyebrow="From your computer"
            title="How to get the QR"
            description="The code is a pairing link. It carries the server address and a mobile token so you do not have to type them."
          >
            <View style={{ gap: 14 }}>
              <HowToStep
                index={1}
                title="Start nikcli on your computer"
                detail="Keep the terminal open while you pair."
              />
              <HowToStep
                index={2}
                title="Show the pairing QR"
                detail="In the TUI choose Connect Mobile, or run nikcli mobile pair."
              />
              <HowToStep index={3} title="Scan it with this phone" detail="Use Scan QR below, or paste the link." />
              <View
                style={{
                  borderRadius: 16,
                  borderCurve: "continuous",
                  borderWidth: 1,
                  borderColor: hexToRgba(palette.ink, 0.08),
                  backgroundColor: palette.background,
                  paddingHorizontal: 14,
                  paddingVertical: 12,
                }}
              >
                <Text selectable style={{ color: palette.soft, ...mono(12) }}>
                  nikcli mobile pair
                </Text>
              </View>
            </View>
          </SurfaceCard>
        ) : null}

        <View style={{ gap: 10 }}>
          <ActionButton label="Scan QR code" onPress={openScanner} disabled={testing} />
          <ActionButton
            label="Paste pairing link"
            variant="secondary"
            loading={testing && !showManual}
            onPress={() => void pastePairingLink()}
          />
        </View>

        {error ? <ErrorBanner message={error} /> : null}

        {showManual ? (
          <SurfaceCard
            eyebrow="Host details"
            title={isAddDevice ? "New device" : "Connect to your server"}
            description="Same fields the QR fills in. Review them, then continue when you are ready."
          >
            <View style={{ gap: 12 }}>
              <TextField
                label="Server URL"
                value={url}
                onChangeText={handleUrlChange}
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="url"
                textContentType="URL"
                placeholder="http://192.168.1.10:4096"
              />
              <TextField
                label="Pairing token (optional)"
                value={token}
                onChangeText={setToken}
                autoCapitalize="none"
                autoCorrect={false}
                placeholder="nkm_…"
              />
              <TextField
                label="Workspace directory"
                value={directory}
                onChangeText={setDirectory}
                autoCapitalize="none"
                autoCorrect={false}
                placeholder="Optional path on the host"
              />
              <ActionButton
                label={testing ? "Connecting…" : "Validate and continue"}
                loading={testing}
                disabled={!form.url}
                onPress={() => void connectWith(form)}
              />
              {mode === "landing" || mode === "pair" ? (
                <ActionButton label="Sign in with a Nikcli account" variant="ghost" onPress={signInWithAccount} />
              ) : null}
            </View>
          </SurfaceCard>
        ) : (
          <ActionButton
            label="Enter server details"
            variant="ghost"
            onPress={() => {
              void triggerHaptic("selection")
              setShowManual(true)
            }}
          />
        )}

        <Text
          selectable
          style={{
            color: palette.muted,
            textAlign: "center",
            ...typeStyle(12),
          }}
        >
          For a local pair, this phone and the computer must share a network. A hosted URL works from anywhere.
        </Text>
      </ScrollView>

      {scanning && process.env.EXPO_OS !== "web" ? (
        <PairingScanner
          onClose={() => setScanning(false)}
          onScanned={(payload) => {
            setScanning(false)
            filledFromPayload(payload)
          }}
        />
      ) : null}
    </KeyboardAvoidingView>
  )
}
