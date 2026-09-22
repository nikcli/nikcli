import { useCallback, useMemo, useState } from "react"
import { Pressable, ScrollView, Text, View } from "react-native"
import { Image } from "expo-image"
import * as WebBrowser from "expo-web-browser"
import { Stack, useFocusEffect } from "expo-router"
import { Github } from "lucide-react-native"
import { ActionButton } from "@/components/ui/ActionButton"
import { ErrorBanner } from "@/components/ui/ErrorBanner"
import { InfoChip } from "@/components/ui/InfoChip"
import { SurfaceCard } from "@/components/ui/SurfaceCard"
import { TextField } from "@/components/ui/TextField"
import { useGithubDeviceAuth } from "@/hooks/use-github-device-auth"
import { useServer } from "@/lib/server-context"
import { hexToRgba, useAppTheme } from "@/lib/theme"
import { type as typeStyle } from "@/lib/typography"
import { type HostConfigSnapshot } from "@/lib/types"

function githubConnectorKey(snapshot: HostConfigSnapshot | null) {
  const entries = Object.entries(snapshot?.connectors ?? {})
  const existing = entries.find(([, value]) => value?.type === "github")
  return existing?.[0] ?? "github"
}

function githubConnector(snapshot: HostConfigSnapshot | null) {
  const key = githubConnectorKey(snapshot)
  const connector = snapshot?.connectors?.[key]
  return typeof connector === "object" && connector !== null ? connector : undefined
}

export default function GithubSettingsScreen() {
  const { client, bootstrap, refreshBootstrap } = useServer()
  const { palette } = useAppTheme()
  const [hostConfig, setHostConfig] = useState<HostConfigSnapshot | null>(null)
  const [githubToken, setGithubToken] = useState("")
  const [githubOauthClientID, setGithubOauthClientID] = useState("")
  const [saving, setSaving] = useState(false)
  const [advancedOauthOpen, setAdvancedOauthOpen] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  const githubConnected = Boolean(bootstrap?.github?.connected)
  const oauthConfigured = Boolean(bootstrap?.github?.oauthDeviceConfigured)
  const githubTokenAvailable = Boolean(bootstrap?.github?.tokenAvailable)
  const reconnectRequired = Boolean(bootstrap?.github?.reconnectRequired)

  const load = useCallback(async () => {
    if (!client) return
    try {
      const nextConfig = await client.getConfig()
      setHostConfig(nextConfig)
      const connector = githubConnector(nextConfig)
      const oauthClientID =
        typeof connector?.oauthClientId === "string"
          ? connector.oauthClientId
          : typeof connector?.clientId === "string"
            ? connector.clientId
            : ""
      setGithubOauthClientID(oauthClientID)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error))
    }
  }, [client])

  useFocusEffect(
    useCallback(() => {
      void load()
    }, [load]),
  )

  const profileChips = useMemo(
    () => [
      oauthConfigured ? "OAuth ready" : "Approve account",
      bootstrap?.github?.oauthClientSource ? `Source ${bootstrap.github.oauthClientSource}` : "Nikcli GitHub App",
      githubTokenAvailable ? "GH token stored" : "GH token missing",
      githubConnected ? "GitHub linked" : reconnectRequired ? "Reconnect needed" : "GitHub offline",
    ],
    [bootstrap?.github?.oauthClientSource, githubConnected, githubTokenAvailable, oauthConfigured, reconnectRequired],
  )

  async function syncBootstrap(messageText?: string) {
    await refreshBootstrap().catch(() => null)
    await load().catch(() => null)
    if (messageText) setMessage(messageText)
  }

  const { oauthBusy, oauthFlow, startGithubOAuth, checkGithubApproval, cancelGithubOAuth } = useGithubDeviceAuth({
    client,
    onApproved: (login) => syncBootstrap(`GitHub connected as @${login}`),
    onMessage: (text) => setMessage(text || null),
  })

  async function persistGithubOAuthClientID() {
    if (!client) return null
    const value = githubOauthClientID.trim()
    if (!value) {
      setMessage("GitHub OAuth client ID is required")
      return null
    }

    try {
      setSaving(true)
      setMessage(null)
      const nextConfig = await client.saveGithubOAuthClientID(value)
      setHostConfig(nextConfig)
      await syncBootstrap("GitHub OAuth client ID saved globally on host")
      return nextConfig
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error))
      return null
    } finally {
      setSaving(false)
    }
  }

  async function connectGithubWithToken() {
    if (!client || !githubToken.trim()) return
    try {
      setSaving(true)
      await client.setGithubToken(githubToken.trim())
      setGithubToken("")
      await syncBootstrap("GitHub token saved on host")
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error))
    } finally {
      setSaving(false)
    }
  }

  async function disconnectGithub() {
    if (!client) return
    try {
      setSaving(true)
      cancelGithubOAuth()
      await client.clearGithubToken()
      await syncBootstrap("GitHub access removed from host")
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error))
    } finally {
      setSaving(false)
    }
  }

  return (
    <ScrollView
      className="flex-1 bg-background"
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={{ paddingHorizontal: 16, paddingTop: 16, paddingBottom: 36, gap: 16 }}
    >
      <Stack.Screen options={{ title: "GitHub" }} />

      <SurfaceCard
        eyebrow="GitHub account"
        title="Approve your GitHub account"
        description="Nikcli already uses the official GitHub App. You only need to approve your GitHub account in the browser."
      >
        <View className="flex-row flex-wrap gap-2">
          {profileChips.map((chip) => (
            <InfoChip
              key={chip}
              label={chip}
              tone={
                chip.includes("ready") || chip.includes("linked") || chip.includes("stored")
                  ? "good"
                  : chip.includes("offline") || chip.includes("missing") || chip.includes("Reconnect")
                    ? "warn"
                    : "neutral"
              }
            />
          ))}
        </View>
      </SurfaceCard>

      {message ? <ErrorBanner message={message} /> : null}

      {reconnectRequired ? (
        <View
          style={{
            borderRadius: 12,
            borderWidth: 1,
            borderColor: hexToRgba(palette.danger, 0.3),
            backgroundColor: hexToRgba(palette.danger, 0.1),
            padding: 16,
            gap: 12,
          }}
        >
          <Text style={{ color: palette.ink, ...typeStyle(14, { weight: "500" }) }}>GitHub session expired</Text>
          <Text style={{ color: palette.soft, ...typeStyle(14) }}>
            Your stored GitHub access expired and couldn't refresh automatically. Reconnect to keep repo import,
            branches, and pull requests working.
          </Text>
          <ActionButton label="Reconnect GitHub" loading={oauthBusy} onPress={() => void startGithubOAuth()} />
        </View>
      ) : null}

      <SurfaceCard
        eyebrow="OAuth device sign-in"
        title="Connect with GitHub"
        description="Nikcli already uses the official GitHub App. Approve your account in the browser — you do not need to type a client ID."
      >
        <View className="gap-3">
          <View className="flex-row items-center gap-3">
            <Image
              source={require("@/assets/app-icon-mark.png")}
              style={{ width: 32, height: 32, borderRadius: 8 }}
              contentFit="cover"
              accessibilityLabel="nikcli"
            />
            <Text style={{ color: palette.soft, ...typeStyle(14) }}>→</Text>
            <View className="size-8 items-center justify-center">
              <Github size={28} color={palette.ink} strokeWidth={1.8} />
            </View>
          </View>

          <ActionButton
            label={githubConnected ? "Reconnect with GitHub" : "Connect with GitHub"}
            loading={oauthBusy}
            onPress={() => void startGithubOAuth()}
          />

          {oauthFlow ? (
            <View
              style={{
                borderRadius: 12,
                borderWidth: 1,
                borderColor: hexToRgba(palette.ink, 0.08),
                backgroundColor: hexToRgba(palette.background, 0.6),
                padding: 16,
              }}
            >
              <Text style={{ color: palette.muted, ...typeStyle(12, { weight: "500" }) }}>
                Authorization in progress
              </Text>
              <Text style={{ marginTop: 8, color: palette.soft, ...typeStyle(14) }}>
                Enter this code in GitHub if the browser page asks for it.
              </Text>
              <View
                style={{
                  marginTop: 12,
                  borderRadius: 16,
                  borderWidth: 1,
                  borderColor: hexToRgba(palette.accent, 0.2),
                  backgroundColor: hexToRgba(palette.accent, 0.1),
                  padding: 16,
                }}
              >
                <Text
                  selectable
                  style={{
                    textAlign: "center",
                    color: palette.ink,
                    letterSpacing: 6,
                    ...typeStyle(28, { weight: "600" }),
                  }}
                >
                  {oauthFlow.userCode}
                </Text>
              </View>
              <View className="mt-3 flex-row gap-2">
                <View className="flex-1">
                  <ActionButton
                    label="Open GitHub"
                    onPress={() =>
                      void WebBrowser.openBrowserAsync(oauthFlow.verificationUriComplete || oauthFlow.verificationUri)
                    }
                  />
                </View>
                <View className="flex-1">
                  <ActionButton
                    label="Check approval"
                    variant="secondary"
                    loading={oauthBusy}
                    onPress={() => void checkGithubApproval()}
                  />
                </View>
              </View>
            </View>
          ) : null}

          <Pressable
            onPress={() => setAdvancedOauthOpen((value) => !value)}
            accessibilityRole="button"
            style={{ minHeight: 44, justifyContent: "center" }}
          >
            <Text style={{ color: palette.soft, ...typeStyle(14, { weight: "500" }) }}>
              {advancedOauthOpen ? "Hide custom OAuth client ID" : "Advanced: custom OAuth client ID"}
            </Text>
          </Pressable>

          {advancedOauthOpen ? (
            <View
              style={{
                gap: 12,
                borderRadius: 12,
                borderWidth: 1,
                borderColor: hexToRgba(palette.ink, 0.08),
                backgroundColor: hexToRgba(palette.background, 0.6),
                padding: 16,
              }}
            >
              <Text style={{ color: palette.soft, ...typeStyle(14) }}>
                Nikcli already ships the official GitHub App client ID. Override it only if this host must use a
                different OAuth application.
              </Text>
              <TextField
                label="GitHub OAuth client ID"
                value={githubOauthClientID}
                onChangeText={setGithubOauthClientID}
                autoCapitalize="none"
                placeholder="Iv1.1234567890abcdef"
              />
              <ActionButton
                label={oauthConfigured ? "Update OAuth client ID" : "Save OAuth client ID"}
                loading={saving}
                variant="secondary"
                onPress={() => void persistGithubOAuthClientID()}
              />
            </View>
          ) : null}
        </View>
      </SurfaceCard>

      <SurfaceCard
        eyebrow="Connected account"
        title={bootstrap?.github?.user?.login ? `@${bootstrap.github.user.login}` : "No linked account"}
        description={
          bootstrap?.github?.user?.name ||
          "Connect GitHub to unlock repo import, branch worktrees, and publish workflows."
        }
      >
        <View className="gap-3">
          {githubConnected ? (
            <ActionButton
              label="Disconnect GitHub"
              variant="secondary"
              disabled={saving}
              onPress={() => void disconnectGithub()}
            />
          ) : null}
        </View>
      </SurfaceCard>

      <SurfaceCard
        eyebrow="Manual fallback"
        title="Service token access"
        description="Use a dedicated token only when OAuth is not available or when the host is intentionally hardened around PAT-based access."
        tone="panel"
      >
        <View className="gap-3">
          <TextField
            label="GitHub token"
            value={githubToken}
            onChangeText={setGithubToken}
            autoCapitalize="none"
            placeholder="ghp_..."
          />
          <ActionButton
            label="Save manual GitHub token"
            variant="secondary"
            loading={saving}
            disabled={!githubToken.trim()}
            onPress={() => void connectGithubWithToken()}
          />
        </View>
      </SurfaceCard>
    </ScrollView>
  )
}
