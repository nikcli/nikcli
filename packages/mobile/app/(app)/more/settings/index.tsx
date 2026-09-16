import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { ActivityIndicator, FlatList, Modal, Pressable, ScrollView, Text, View } from "react-native"
import * as WebBrowser from "expo-web-browser"
import { Link, useFocusEffect, type Href } from "expo-router"
import { SettingsGroup, SettingsNavCard } from "@/components/settings/SettingsNavCard"
import { useColorScheme } from "nativewind"
import { ActionButton } from "@/components/ui/ActionButton"
import { ErrorBanner } from "@/components/ui/ErrorBanner"
import { InfoChip, optionChipStyle, optionChipTextColor } from "@/components/ui/InfoChip"
import { SurfaceCard } from "@/components/ui/SurfaceCard"
import { TextField } from "@/components/ui/TextField"
import { CenteredScreenHeader } from "@/components/layout/CenteredScreenHeader"
import { SectionHeader } from "@/components/ui/SectionHeader"
import { useServer } from "@/lib/server-context"
import { setAppPreferencesWith } from "@/lib/storage"
import { ensureNotificationPermissions } from "@/lib/notifications"
import { useUIStore } from "@/lib/store"
import { hexToRgba, useAppTheme, useTheme, THEME_LIST } from "@/lib/theme"
import { type as typeStyle } from "@/lib/typography"
import {
  type HostConfigSnapshot,
  type HostMcpConfig,
  type HostMcpStatus,
  MOBILE_DEFAULT_MODEL_ID,
  MOBILE_DEFAULT_PROVIDER_ID,
  type SettingsSectionID,
  type SkillInfo,
  type ThemeMode,
  type GitHubDeviceAuthStart,
  type MobileExecutionTarget,
  type ProviderCatalog,
} from "@/lib/types"

const EMPTY_ROWS: never[] = []

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function maybeHandle(message: string | null) {
  return message ? <ErrorBanner message={message} /> : null
}

function providerFallback(catalog: ProviderCatalog | null) {
  if (!catalog?.all.length) return MOBILE_DEFAULT_PROVIDER_ID
  if (catalog.all.some((provider) => provider.id === MOBILE_DEFAULT_PROVIDER_ID)) {
    return MOBILE_DEFAULT_PROVIDER_ID
  }
  return [...catalog.all].sort((left, right) => left.name.localeCompare(right.name)).at(0)?.id
}

function modelFallback(catalog: ProviderCatalog | null, providerID: string) {
  const provider = catalog?.all.find((item) => item.id === providerID)
  if (!provider) return providerID === MOBILE_DEFAULT_PROVIDER_ID ? MOBILE_DEFAULT_MODEL_ID : undefined
  if (provider.models[MOBILE_DEFAULT_MODEL_ID] && providerID === MOBILE_DEFAULT_PROVIDER_ID)
    return MOBILE_DEFAULT_MODEL_ID
  if (catalog?.default[providerID] && provider.models[catalog.default[providerID]]) return catalog.default[providerID]
  return Object.values(provider.models)
    .sort((left, right) => left.name.localeCompare(right.name))
    .at(0)?.id
}

function mcpTone(status?: HostMcpStatus): "accent" | "good" | "warn" | "neutral" {
  if (!status) return "neutral"
  if (status.status === "connected") return "good"
  if (status.status === "needs_auth" || status.status === "failed" || status.status === "needs_client_registration")
    return "warn"
  return "neutral"
}

function mcpLabel(status?: HostMcpStatus) {
  if (!status) return "Unknown"
  switch (status.status) {
    case "connected":
      return "Connected"
    case "disabled":
      return "Disabled"
    case "needs_auth":
      return "Needs auth"
    case "needs_client_registration":
      return "Needs registration"
    case "failed":
      return "Failed"
  }
}

const SETTINGS_SECTIONS: Array<{ id: SettingsSectionID; label: string }> = [
  { id: "profile", label: "Profile" },
  { id: "interaction", label: "Interaction" },
  { id: "commands", label: "Commands" },
  { id: "memories", label: "Memories" },
  { id: "connection", label: "Connection" },
  { id: "execution", label: "Execution" },
  { id: "providers", label: "Models" },
  { id: "github", label: "GitHub" },
  { id: "mcp", label: "MCP" },
  { id: "connectors", label: "Connectors" },
  { id: "skills", label: "Skills" },
  { id: "agents", label: "Agents" },
  { id: "tokens", label: "Tokens" },
  { id: "permissions", label: "Permissions" },
  { id: "plugins", label: "Plugins" },
  { id: "advanced", label: "Advanced" },
]

function githubConnectorKey(snapshot: HostConfigSnapshot | null) {
  const entries = Object.entries(snapshot?.connectors ?? {})
  const existing = entries.find(([, value]) => value?.type === "github")
  return existing?.[0] ?? "github"
}

export default function SettingsScreen() {
  const { client, config, bootstrap, bootstrapLoading, refreshBootstrap, save, clear, currentUser, signOut } =
    useServer()
  const { palette, colorScheme } = useAppTheme()
  const { themeId, themeName, setTheme } = useTheme()
  const { setColorScheme } = useColorScheme()
  const [themePickerOpen, setThemePickerOpen] = useState(false)
  const themeMode = useUIStore((state) => state.themeMode)
  const setThemeMode = useUIStore((state) => state.setThemeMode)
  const visibleSettingsSections = useUIStore((state) => state.visibleSettingsSections)
  const setSettingsSectionVisible = useUIStore((state) => state.setSettingsSectionVisible)
  const notifications = useUIStore((state) => state.notifications)
  const haptics = useUIStore((state) => state.haptics)
  const gestures = useUIStore((state) => state.gestures)
  const composer = useUIStore((state) => state.composer)
  const promptPresets = useUIStore((state) => state.promptPresets)
  const setNotificationPreference = useUIStore((state) => state.setNotificationPreference)
  const setHapticPreference = useUIStore((state) => state.setHapticPreference)
  const setGesturePreference = useUIStore((state) => state.setGesturePreference)
  const [url, setUrl] = useState(config?.url ?? "")
  const [token, setToken] = useState(config?.token ?? "")
  const [directory, setDirectory] = useState(config?.directory ?? "")
  const [selectedExecutionTarget, setSelectedExecutionTarget] = useState<MobileExecutionTarget>(
    config?.executionTarget ?? "local",
  )
  const [providerCatalog, setProviderCatalog] = useState<ProviderCatalog | null>(null)
  const [providerSearch, setProviderSearch] = useState("")
  const [modelSearch, setModelSearch] = useState("")
  const [selectedProviderID, setSelectedProviderID] = useState(config?.modelProviderID ?? MOBILE_DEFAULT_PROVIDER_ID)
  const [selectedModelID, setSelectedModelID] = useState(config?.modelID ?? MOBILE_DEFAULT_MODEL_ID)
  const [providerKey, setProviderKey] = useState("")
  const [githubToken, setGithubToken] = useState("")
  const [hostConfig, setHostConfig] = useState<HostConfigSnapshot | null>(null)
  const [mcpStatus, setMcpStatus] = useState<Record<string, HostMcpStatus>>({})
  const [skills, setSkills] = useState<SkillInfo[]>([])
  const [skillsSearch, setSkillsSearch] = useState("")
  const [mcpName, setMcpName] = useState("")
  const [mcpType, setMcpType] = useState<HostMcpConfig["type"]>("remote")
  const [mcpUrl, setMcpUrl] = useState("")
  const [mcpCommand, setMcpCommand] = useState("")
  const [saving, setSaving] = useState(false)
  const [providerLoading, setProviderLoading] = useState(false)
  const [providerSaving, setProviderSaving] = useState(false)
  const [defaultsSaving, setDefaultsSaving] = useState(false)
  const [oauthBusy, setOauthBusy] = useState(false)
  const [mcpBusy, setMcpBusy] = useState(false)
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [oauthFlow, setOauthFlow] = useState<GitHubDeviceAuthStart | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const authRun = useRef(0)

  const [prevConfig, setPrevConfig] = useState(config)
  if (config !== prevConfig) {
    setPrevConfig(config)
    setUrl(config?.url ?? "")
    setToken(config?.token ?? "")
    setDirectory(config?.directory ?? "")
    setSelectedExecutionTarget(config?.executionTarget ?? "local")
    setSelectedProviderID(config?.modelProviderID ?? MOBILE_DEFAULT_PROVIDER_ID)
    setSelectedModelID(config?.modelID ?? MOBILE_DEFAULT_MODEL_ID)
  }

  const githubOauthClientID = useMemo(() => {
    if (typeof hostConfig?.connectors?.github?.oauthClientId === "string") {
      return hostConfig.connectors.github.oauthClientId
    }
    if (typeof hostConfig?.connectors?.github?.clientId === "string") {
      return hostConfig.connectors.github.clientId
    }
    return ""
  }, [hostConfig])
  const [githubOauthClientIDDraft, setGithubOauthClientID] = useState(githubOauthClientID)

  useEffect(() => {
    setGithubOauthClientID(githubOauthClientID)
  }, [githubOauthClientID])

  useEffect(() => {
    setColorScheme(themeMode)
  }, [setColorScheme, themeMode])

  const loadProviderData = useCallback(async () => {
    if (!client) {
      setProviderCatalog(null)
      return
    }

    try {
      setProviderLoading(true)
      const catalog = await client.listProviders()
      setProviderCatalog(catalog)

      const nextProvider = (() => {
        if (config?.modelProviderID && catalog.all.some((item) => item.id === config.modelProviderID)) {
          return config.modelProviderID
        }
        if (catalog.all.some((item) => item.id === selectedProviderID)) return selectedProviderID
        return providerFallback(catalog)
      })()

      if (nextProvider) {
        setSelectedProviderID(nextProvider)
        const nextModel = (() => {
          const provider = catalog.all.find((item) => item.id === nextProvider)
          if (!provider) return undefined
          if (config?.modelProviderID === nextProvider && config?.modelID && provider.models[config.modelID]) {
            return config.modelID
          }
          if (provider.models[selectedModelID]) return selectedModelID
          return modelFallback(catalog, nextProvider)
        })()
        if (nextModel) setSelectedModelID(nextModel)
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error))
    } finally {
      setProviderLoading(false)
    }
  }, [client, config?.modelID, config?.modelProviderID, selectedModelID, selectedProviderID])

  const loadAutomationData = useCallback(async () => {
    if (!client) {
      setHostConfig(null)
      setMcpStatus({})
      setSkills([])
      return
    }

    try {
      const [nextConfig, nextMcpStatus, nextSkills] = await Promise.all([
        client.getConfig(),
        client.listMcpStatus(),
        client.listSkills(),
      ])
      setHostConfig(nextConfig)
      setMcpStatus(nextMcpStatus)
      setSkills(nextSkills)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error))
    }
  }, [client])

  useFocusEffect(
    useCallback(() => {
      setMessage(null)
      void loadProviderData()
      void loadAutomationData()
    }, [loadAutomationData, loadProviderData]),
  )

  async function saveConnection() {
    const nextUrl = url.trim()
    if (!nextUrl) {
      setMessage("Server URL is required")
      return
    }
    if (!token.trim()) {
      setMessage("Mobile pairing token is required")
      return
    }

    if (selectedExecutionTarget === "container" && !bootstrap?.execution?.container?.available) {
      setMessage("Container sandbox requires Docker or Podman on the server")
      return
    }

    try {
      setSaving(true)
      setMessage(null)
      await save({
        ...config,
        url: nextUrl,
        token: token.trim(),
        directory: directory.trim() || undefined,
        modelProviderID: selectedProviderID,
        modelID: selectedModelID,
        executionTarget: selectedExecutionTarget,
      })
      setMessage("Server connection updated")
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error))
    } finally {
      setSaving(false)
    }
  }

  async function syncBootstrap(messageText?: string) {
    await refreshBootstrap().catch(() => null)
    await loadAutomationData().catch(() => null)
    if (messageText) setMessage(messageText)
  }

  // persistPreferences is intentionally defined here because each field's
  // type is derived from the component's local useState (via `typeof`).
  // Hoisting it would require extracting those types, which would
  // duplicate them. The function does NOT read live state — it only
  // uses the supplied `next` argument — so the runtime cost of
  // rebuilding it per render is negligible compared to the type churn.
  // oxlint-disable-next-line react-doctor/prefer-module-scope-pure-function
  function persistPreferences(next: {
    themeMode?: ThemeMode
    visibleSettingsSections?: Record<SettingsSectionID, boolean>
    notifications?: typeof notifications
    haptics?: typeof haptics
    gestures?: typeof gestures
    composer?: typeof composer
    promptPresets?: typeof promptPresets
  }) {
    // Routes through setAppPreferencesWith so two quick toggles serialize:
    // the merger reads the latest stored document, applies the delta, and
    // writes the merged result. Without serialisation, two parallel calls
    // would both read the same stale \`current\` and lose any field
    // touched by the other.
    return setAppPreferencesWith((current) => ({
      themeMode: next.themeMode ?? current.themeMode,
      visibleSettingsSections: next.visibleSettingsSections ?? current.visibleSettingsSections,
      notifications: next.notifications ?? current.notifications,
      haptics: next.haptics ?? current.haptics,
      gestures: next.gestures ?? current.gestures,
      composer: next.composer ?? current.composer,
      promptPresets: next.promptPresets ?? current.promptPresets,
      wallpaper: current.wallpaper,
      security: current.security,
      tipsHidden: current.tipsHidden,
      mathEnabled: current.mathEnabled,
    }))
  }

  async function applyThemeMode(nextMode: ThemeMode) {
    setThemeMode(nextMode)
    await persistPreferences({
      themeMode: nextMode,
      visibleSettingsSections,
      notifications,
      haptics,
      gestures,
      composer,
      promptPresets,
    })
  }

  async function toggleSettingsSection(section: SettingsSectionID) {
    const nextVisible = !visibleSettingsSections[section]
    const nextSections = {
      ...visibleSettingsSections,
      [section]: nextVisible,
    }
    setSettingsSectionVisible(section, nextVisible)
    await persistPreferences({
      themeMode,
      visibleSettingsSections: nextSections,
      notifications,
      haptics,
      gestures,
      composer,
      promptPresets,
    })
  }

  async function updateNotificationPreference<K extends keyof typeof notifications>(
    key: K,
    value: (typeof notifications)[K],
  ) {
    if (key === "enabled" && value === true) {
      const granted = await ensureNotificationPermissions(true)
      if (!granted) {
        setMessage("Notification permission was not granted on this device")
        return
      }
    }
    const next = {
      ...notifications,
      [key]: value,
    }
    setNotificationPreference(key, value)
    await persistPreferences({
      themeMode,
      visibleSettingsSections,
      notifications: next,
      haptics,
      gestures,
      composer,
      promptPresets,
    })
  }

  async function updateHapticPreference<K extends keyof typeof haptics>(key: K, value: (typeof haptics)[K]) {
    const next = {
      ...haptics,
      [key]: value,
    }
    setHapticPreference(key, value)
    await persistPreferences({
      themeMode,
      visibleSettingsSections,
      notifications,
      haptics: next,
      gestures,
      composer,
      promptPresets,
    })
  }

  async function updateGesturePreference<K extends keyof typeof gestures>(key: K, value: (typeof gestures)[K]) {
    const next = {
      ...gestures,
      [key]: value,
    }
    setGesturePreference(key, value)
    await persistPreferences({
      themeMode,
      visibleSettingsSections,
      notifications,
      haptics,
      gestures: next,
      composer,
      promptPresets,
    })
  }

  async function persistGithubOAuthClientID() {
    if (!client) return
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

  async function saveGithubOAuthClientID() {
    await persistGithubOAuthClientID()
  }

  async function addMcpServer() {
    if (!client) return
    const name = mcpName.trim()
    if (!name) {
      setMessage("MCP server name is required")
      return
    }
    if (mcpType === "remote" && !mcpUrl.trim()) {
      setMessage("Remote MCP URL is required")
      return
    }
    if (mcpType === "local" && !mcpCommand.trim()) {
      setMessage("Local MCP command is required")
      return
    }

    try {
      setMcpBusy(true)
      setMessage(null)
      const snapshot = hostConfig ?? (await client.getConfig())
      const nextMcp = { ...(snapshot.mcp ?? {}) }

      if (mcpType === "remote") {
        nextMcp[name] = {
          type: "remote",
          url: mcpUrl.trim(),
          enabled: true,
        }
      } else {
        nextMcp[name] = {
          type: "local",
          command: mcpCommand.trim().split(/\s+/),
          enabled: true,
        }
      }

      const nextConfig = await client.updateConfig({
        ...snapshot,
        mcp: nextMcp,
      })
      setHostConfig(nextConfig)
      setMcpName("")
      setMcpUrl("")
      setMcpCommand("")
      await loadAutomationData()
      setMessage(`Saved MCP server ${name}`)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error))
    } finally {
      setMcpBusy(false)
    }
  }

  async function toggleMcpEnabled(name: string, enabled: boolean) {
    if (!client || !hostConfig?.mcp?.[name]) return
    try {
      setMcpBusy(true)
      const nextConfig = await client.updateConfig({
        ...hostConfig,
        mcp: {
          ...(hostConfig.mcp ?? {}),
          [name]: {
            ...hostConfig.mcp[name],
            enabled,
          },
        },
      })
      setHostConfig(nextConfig)
      await loadAutomationData()
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error))
    } finally {
      setMcpBusy(false)
    }
  }

  async function connectMcp(name: string) {
    if (!client) return
    try {
      setMcpBusy(true)
      await client.connectMcp(name)
      await loadAutomationData()
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error))
    } finally {
      setMcpBusy(false)
    }
  }

  async function disconnectMcp(name: string) {
    if (!client) return
    try {
      setMcpBusy(true)
      await client.disconnectMcp(name)
      await loadAutomationData()
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error))
    } finally {
      setMcpBusy(false)
    }
  }

  async function authenticateMcp(name: string) {
    if (!client) return
    try {
      setMcpBusy(true)
      const result = await client.startMcpAuth(name)
      await WebBrowser.openBrowserAsync(result.authorizationUrl)
      setMessage(`MCP auth opened for ${name}`)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error))
    } finally {
      setMcpBusy(false)
    }
  }

  async function clearMcpAuth(name: string) {
    if (!client) return
    try {
      setMcpBusy(true)
      await client.removeMcpAuth(name)
      await loadAutomationData()
      setMessage(`Removed MCP auth for ${name}`)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error))
    } finally {
      setMcpBusy(false)
    }
  }

  async function waitForApproval(flow: GitHubDeviceAuthStart, runID: number) {
    let interval = flow.interval
    while (Date.now() < flow.expiresAt && authRun.current === runID) {
      if (authRun.current !== runID || !client) return
      await sleep(interval * 1000)
      if (authRun.current !== runID || !client) return
      const result = await client.pollGithubDeviceAuth(flow.deviceCode)
      if (result.status === "pending") {
        interval = result.interval ?? interval
        continue
      }
      if (result.status === "approved") {
        authRun.current = 0
        setOauthFlow(null)
        await syncBootstrap(`GitHub connected as @${result.user?.login}`)
        return
      }
      if (result.status === "denied") {
        authRun.current = 0
        setOauthFlow(null)
        setMessage("GitHub authorization was denied")
        return
      }
      if (result.status === "expired") {
        authRun.current = 0
        setOauthFlow(null)
        setMessage("GitHub authorization expired. Start a new sign-in.")
        return
      }
    }
    if (authRun.current === runID) {
      authRun.current = 0
      setOauthFlow(null)
      setMessage("GitHub authorization expired. Start a new sign-in.")
    }
  }

  async function startGithubOAuth() {
    if (!client) return

    try {
      setOauthBusy(true)
      setMessage(null)
      const flow = await client.startGithubDeviceAuth()
      const runID = Date.now()
      authRun.current = runID
      setOauthFlow(flow)
      void WebBrowser.openBrowserAsync(flow.verificationUriComplete || flow.verificationUri)
      void waitForApproval(flow, runID)
      setMessage("Approve GitHub in your browser. The app is waiting for confirmation.")
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error)
      setMessage(
        /github oauth client id is not configured/i.test(text)
          ? "This nikcli host has no GitHub client ID. Update nikcli on the computer, or set one under OAuth client ID below."
          : text,
      )
    } finally {
      setOauthBusy(false)
    }
  }

  async function checkGithubApproval() {
    if (!client || !oauthFlow) return
    try {
      setOauthBusy(true)
      const result = await client.pollGithubDeviceAuth(oauthFlow.deviceCode)
      if (result.status === "approved") {
        authRun.current = 0
        setOauthFlow(null)
        await syncBootstrap(`GitHub connected as @${result.user?.login}`)
        return
      }
      if (result.status === "pending") {
        setMessage("Still waiting for GitHub approval.")
        return
      }
      if (result.status === "denied") {
        authRun.current = 0
        setOauthFlow(null)
        setMessage("GitHub authorization was denied")
        return
      }
      authRun.current = 0
      setOauthFlow(null)
      setMessage("GitHub authorization expired. Start a new sign-in.")
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error))
    } finally {
      setOauthBusy(false)
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
      authRun.current = 0
      setOauthFlow(null)
      await client.clearGithubToken()
      await syncBootstrap("GitHub access removed from host")
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error))
    } finally {
      setSaving(false)
    }
  }

  const githubConnected = Boolean(bootstrap?.github?.connected)
  const containerReady = Boolean(bootstrap?.execution?.container?.available)
  const containerRuntime = bootstrap?.execution?.container?.runtime
  const workspaceLabel = bootstrap?.currentProject?.name || bootstrap?.currentProject?.id || "No workspace"
  const oauthConfigured = Boolean(bootstrap?.github?.oauthDeviceConfigured)
  const githubTokenAvailable = Boolean(bootstrap?.github?.tokenAvailable)
  const currentToken = bootstrap?.auth.currentToken
  const mcpEntries = useMemo(() => Object.entries(hostConfig?.mcp ?? {}), [hostConfig?.mcp])
  const visibleSkills = useMemo(() => {
    const term = skillsSearch.trim().toLowerCase()
    if (!term) return skills
    return skills.filter((skill) =>
      [skill.name, skill.description, skill.category ?? "", ...(skill.tags ?? [])].some((value) =>
        value.toLowerCase().includes(term),
      ),
    )
  }, [skills, skillsSearch])

  async function forgetHost() {
    authRun.current = 0
    setOauthFlow(null)
    await clear()
    setMessage("Host configuration removed from this device")
  }

  const connectedProviders = useMemo(() => new Set(providerCatalog?.connected ?? []), [providerCatalog])

  const visibleProviders = useMemo(() => {
    const providers = [...(providerCatalog?.all ?? [])]
    providers.sort((left, right) => {
      const leftScore = left.id === MOBILE_DEFAULT_PROVIDER_ID ? 3 : connectedProviders.has(left.id) ? 2 : 1
      const rightScore = right.id === MOBILE_DEFAULT_PROVIDER_ID ? 3 : connectedProviders.has(right.id) ? 2 : 1
      if (leftScore !== rightScore) return rightScore - leftScore
      return left.name.localeCompare(right.name)
    })

    const term = providerSearch.trim().toLowerCase()
    if (!term) return providers
    return providers.filter((provider) =>
      [provider.name, provider.id, ...provider.env].some((value) => value.toLowerCase().includes(term)),
    )
  }, [connectedProviders, providerCatalog, providerSearch])

  const selectedProvider = useMemo(
    () => providerCatalog?.all.find((provider) => provider.id === selectedProviderID) ?? null,
    [providerCatalog, selectedProviderID],
  )

  const visibleModels = useMemo(() => {
    if (!selectedProvider) return []
    const models = Object.values(selectedProvider.models)
    const defaultModelID = providerCatalog?.default[selectedProvider.id]
    models.sort((left, right) => {
      const leftDefault = left.id === defaultModelID ? 1 : 0
      const rightDefault = right.id === defaultModelID ? 1 : 0
      if (leftDefault !== rightDefault) return rightDefault - leftDefault
      return left.name.localeCompare(right.name)
    })
    const term = modelSearch.trim().toLowerCase()
    const filtered = !term
      ? models
      : models.filter((model) =>
          [model.name, model.id, model.status].some((value) => value.toLowerCase().includes(term)),
        )
    return filtered.slice(0, 24)
  }, [modelSearch, providerCatalog, selectedProvider])

  const providerConnected = selectedProvider ? connectedProviders.has(selectedProvider.id) : false

  async function saveSessionDefaults() {
    if (!config) {
      setMessage("Link a host before saving mobile session defaults")
      return
    }

    try {
      setDefaultsSaving(true)
      setMessage(null)
      await save({
        ...config,
        modelProviderID: selectedProviderID,
        modelID: selectedModelID,
      })
      setMessage(`New mobile sessions now start with ${selectedModelID}`)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error))
    } finally {
      setDefaultsSaving(false)
    }
  }

  async function saveProviderKey() {
    if (!client || !selectedProviderID || !providerKey.trim()) return

    try {
      setProviderSaving(true)
      setMessage(null)
      await client.setProviderApiKey(selectedProviderID, providerKey.trim())
      setProviderKey("")
      await loadProviderData()
      setMessage(`${selectedProvider?.name ?? selectedProviderID} API key saved on host`)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error))
    } finally {
      setProviderSaving(false)
    }
  }

  async function removeProviderKey() {
    if (!client || !selectedProviderID) return

    try {
      setProviderSaving(true)
      setMessage(null)
      await client.removeProviderAuth(selectedProviderID)
      await loadProviderData()
      setMessage(`${selectedProvider?.name ?? selectedProviderID} credentials removed from host`)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error))
    } finally {
      setProviderSaving(false)
    }
  }

  function chooseProvider(providerID: string) {
    setSelectedProviderID(providerID)
    setModelSearch("")
    const nextModel = modelFallback(providerCatalog, providerID)
    if (nextModel) setSelectedModelID(nextModel)
  }

  return (
    <View className="flex-1 bg-background" style={{ paddingHorizontal: 16, paddingTop: 16 }}>
      <FlatList
        contentInsetAdjustmentBehavior="automatic"
        data={EMPTY_ROWS}
        keyExtractor={() => "_"}
        renderItem={() => null}
        contentContainerStyle={{ paddingBottom: 36 }}
        ListHeaderComponent={
          <View style={{ gap: 16 }}>
            <CenteredScreenHeader title="Settings" />
            <View className="flex-row flex-wrap gap-2">
              <InfoChip label={config ? "Host linked" : "Host offline"} tone={config ? "good" : "warn"} />
              <InfoChip
                label={githubConnected ? `GitHub @${bootstrap?.github?.user?.login || "connected"}` : "GitHub offline"}
                tone={githubConnected ? "good" : "warn"}
              />
              <InfoChip label={selectedExecutionTarget === "container" ? "Container" : "Local"} tone="accent" />
              {bootstrapLoading ? <InfoChip label="Refreshing" /> : null}
            </View>

            {maybeHandle(message)}

            <View>
              <SectionHeader label="Manage" />
              <SettingsGroup>
                {visibleSettingsSections.profile ? (
                  <Link href="/user" asChild>
                    <SettingsNavCard
                      eyebrow="Profile"
                      title="Users and access"
                      description="Manage the current account and other server users."
                      badges={[currentUser?.username || "Current user"]}
                    />
                  </Link>
                ) : null}
                {visibleSettingsSections.commands ? (
                  <Link href="/more/settings/commands" asChild>
                    <SettingsNavCard
                      eyebrow="Commands"
                      title="Custom commands and presets"
                      description="Add host slash commands, tune composer defaults, and manage reusable mobile presets."
                      badges={[
                        `${hostConfig?.command ? Object.keys(hostConfig.command).length : 0} host`,
                        `${promptPresets.length} presets`,
                      ]}
                    />
                  </Link>
                ) : null}
                {visibleSettingsSections.memories ? (
                  <Link href="/more/settings/memories" asChild>
                    <SettingsNavCard
                      eyebrow="Memories"
                      title="Prompt history and reusable snippets"
                      description="Browse host-backed prompt history, keep snippets, and build reusable operator context."
                      badges={["Host-backed", "Reusable context"]}
                    />
                  </Link>
                ) : null}
                {visibleSettingsSections.providers ? (
                  <Link href="/more/settings/providers" asChild>
                    <SettingsNavCard
                      eyebrow="Models"
                      title="Providers and default models"
                      description="Focus provider auth, model selection, and default session model behavior in a dedicated control screen."
                      badges={[selectedProviderID || "No provider", selectedModelID || "No model"]}
                    />
                  </Link>
                ) : null}
                {visibleSettingsSections.github ? (
                  <Link href="/more/settings/github" asChild>
                    <SettingsNavCard
                      eyebrow="GitHub"
                      title="OAuth and account trust"
                      description="Manage device sign-in, fallback token access, and the host GitHub identity posture from one enterprise screen."
                      badges={[
                        githubConnected ? "Connected" : oauthConfigured ? "Approve account" : "Needs client ID",
                        oauthConfigured ? "OAuth ready" : "Needs client ID",
                        githubTokenAvailable ? "GH token stored" : "No GH token",
                      ]}
                    />
                  </Link>
                ) : null}
                {visibleSettingsSections.mcp ? (
                  <Link href="/more/settings/mcp" asChild>
                    <SettingsNavCard
                      eyebrow="MCP"
                      title="Automation endpoints"
                      description="Manage Model Context Protocol servers, auth, enablement, and live capability health."
                      badges={[`${mcpEntries.length} configured`, `${Object.keys(mcpStatus).length} live`]}
                    />
                  </Link>
                ) : null}
                {visibleSettingsSections.connectors ? (
                  <Link href="/more/settings/connectors" asChild>
                    <SettingsNavCard
                      eyebrow="Integrations"
                      title="Connectors"
                      description="Connect Figma, Slack, Discord, Linear, Lovable, and Teams to the AI host."
                      badges={["Figma", "Slack", "Linear", "Lovable"]}
                    />
                  </Link>
                ) : null}
                {visibleSettingsSections.skills ? (
                  <Link href="/more/settings/skills" asChild>
                    <SettingsNavCard
                      eyebrow="Skills"
                      title="Discovered skill catalog"
                      description="Browse the host skill registry with better focus than the inline overview can provide."
                      badges={[`${skills.length} skills`, "Host catalog"]}
                    />
                  </Link>
                ) : null}
                {visibleSettingsSections.agents ? (
                  <Link href="/more/settings/agents" asChild>
                    <SettingsNavCard
                      eyebrow="Automation"
                      title="Agents"
                      description="Browse built-in and custom AI agents with their tool selections."
                      badges={["Built-in", "Custom"]}
                    />
                  </Link>
                ) : null}
                <Link href={"/more/settings/security" as Href} asChild>
                  <SettingsNavCard
                    eyebrow="Security"
                    title="Security"
                    description="Unlock the app with Face ID or device biometrics when you return from background."
                    badges={["Face ID", "Biometrics"]}
                  />
                </Link>
                {visibleSettingsSections.tokens ? (
                  <Link href="/more/settings/tokens" asChild>
                    <SettingsNavCard
                      eyebrow="Security"
                      title="Access Tokens"
                      description="Create and revoke long-lived mobile bearer tokens for this server connection."
                      badges={["Bearer auth"]}
                    />
                  </Link>
                ) : null}
                {visibleSettingsSections.permissions ? (
                  <Link href={"/more/settings/permissions" as Href} asChild>
                    <SettingsNavCard
                      eyebrow="Security"
                      title="Tool permissions"
                      description="Require approval, approve for me, or full access — plus per-tool Allow / Ask / Deny rules."
                      badges={["Presets", "Per-tool"]}
                    />
                  </Link>
                ) : null}
                {visibleSettingsSections.plugins ? (
                  <Link href="/more/settings/plugins" asChild>
                    <SettingsNavCard
                      eyebrow="Plugins"
                      title="Codex, Cursor and Copilot"
                      description="Connect third-party AI plugin providers with API keys directly on the host."
                      badges={["Codex", "Cursor", "Copilot"]}
                    />
                  </Link>
                ) : null}
              </SettingsGroup>
            </View>

            {visibleSettingsSections.profile ? (
              <SurfaceCard
                eyebrow="Operator profile"
                title="Identity and control plane"
                description="Inspect the host, token posture, active workspace, and connected GitHub identity from one compact profile surface."
              >
                <View className="flex-row flex-wrap gap-2">
                  <InfoChip
                    label={bootstrap?.version ? `Nikcli ${bootstrap.version}` : "Nikcli unknown"}
                    tone="accent"
                  />
                  <InfoChip label={config?.url ? config.url.replace(/^https?:\/\//, "") : "No server"} />
                  <InfoChip label={themeMode === "system" ? `Theme: ${colorScheme}` : `Theme: ${themeMode}`} />
                  <InfoChip
                    label={bootstrap?.projects?.length ? `${bootstrap.projects.length} projects` : "No projects"}
                  />
                </View>

                <View className="mt-4 gap-3">
                  <SurfaceCard
                    tone="background"
                    eyebrow="GitHub profile"
                    title={bootstrap?.github?.user?.login ? `@${bootstrap.github.user.login}` : "Not connected"}
                    description={
                      bootstrap?.github?.user?.name
                        ? `${bootstrap.github.user.name} · OAuth ${oauthConfigured ? "Nikcli GitHub App · approve your account" : "not configured yet"}`
                        : `OAuth ${oauthConfigured ? "Nikcli GitHub App · approve your account" : "not configured yet"}`
                    }
                  />

                  <SurfaceCard
                    tone="background"
                    eyebrow="Host profile"
                    title={workspaceLabel}
                    description={
                      currentToken
                        ? `${config?.directory || "No default directory selected"} · Mobile token ${currentToken.name} · created ${new Date(currentToken.createdAt).toLocaleDateString()}`
                        : `${config?.directory || "No default directory selected"} · No mobile bearer token metadata available.`
                    }
                  />
                </View>
              </SurfaceCard>
            ) : null}

            <SurfaceCard
              eyebrow="Appearance"
              title="Compact premium interface"
              description="Tune the global theme and choose which settings surfaces stay visible on this device."
            >
              <View className="flex-row flex-wrap gap-2">
                <InfoChip
                  label={`Theme ${themeMode === "system" ? `system (${colorScheme})` : themeMode}`}
                  tone="accent"
                />
                <InfoChip label={visibleSettingsSections.mcp ? "MCP visible" : "MCP hidden"} />
                <InfoChip label={visibleSettingsSections.skills ? "Skills visible" : "Skills hidden"} />
              </View>

              <View
                style={{
                  marginTop: 16,
                  borderRadius: 12,
                  borderWidth: 1,
                  borderColor: hexToRgba(palette.ink, 0.08),
                  backgroundColor: hexToRgba(palette.background, 0.6),
                  padding: 16,
                }}
              >
                <Text style={{ color: palette.muted, ...typeStyle(12, { weight: "500" }) }}>Color theme</Text>
                <Pressable
                  onPress={() => setThemePickerOpen(true)}
                  accessibilityRole="button"
                  accessibilityLabel={`Current theme ${themeName}`}
                  style={[
                    optionChipStyle(palette, true),
                    { marginTop: 12, flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
                  ]}
                >
                  <View>
                    <Text style={{ color: palette.ink, ...typeStyle(14, { weight: "600" }) }}>{themeName}</Text>
                    <Text style={{ marginTop: 4, color: palette.soft, ...typeStyle(12) }}>Tap to change theme</Text>
                  </View>
                  <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                    <View
                      style={{
                        width: 24,
                        height: 24,
                        borderRadius: 12,
                        borderWidth: 2,
                        borderColor: hexToRgba(palette.ink, 0.12),
                        backgroundColor: palette.accent,
                      }}
                    />
                    <Text style={{ color: palette.ink, ...typeStyle(14) }}>▼</Text>
                  </View>
                </Pressable>
              </View>

              <View className="mt-4 flex-row gap-2">
                {(["system", "light", "dark"] as ThemeMode[]).map((mode) => {
                  const active = themeMode === mode
                  return (
                    <Pressable
                      key={mode}
                      onPress={() => void applyThemeMode(mode)}
                      style={[
                        optionChipStyle(palette, active),
                        { flex: 1, minWidth: 0, borderRadius: 18, padding: 12 },
                      ]}
                    >
                      <Text
                        style={{
                          color: optionChipTextColor(palette, active),
                          textTransform: "capitalize",
                          ...typeStyle(14, { weight: "600" }),
                        }}
                      >
                        {mode}
                      </Text>
                      <Text style={{ marginTop: 4, color: palette.soft, ...typeStyle(12) }}>
                        {mode === "system"
                          ? "Follow the device appearance automatically."
                          : mode === "light"
                            ? "Bright, crisp control plane surfaces."
                            : "Dark, focused operator mode."}
                      </Text>
                    </Pressable>
                  )
                })}
              </View>

              <View className="mt-4">
                <Link href={"/more/settings/appearance" as Href} asChild>
                  <SettingsNavCard
                    eyebrow="Session"
                    title="Wallpaper, math, and tips"
                    description="Chat backdrop, LaTeX in bubbles, and rotating home tips."
                  />
                </Link>
              </View>

              <View
                style={{
                  marginTop: 16,
                  borderRadius: 12,
                  borderWidth: 1,
                  borderColor: hexToRgba(palette.ink, 0.08),
                  backgroundColor: hexToRgba(palette.background, 0.6),
                  padding: 16,
                }}
              >
                <Text style={{ color: palette.muted, ...typeStyle(12, { weight: "500" }) }}>
                  Visible settings sections
                </Text>
                <View style={{ marginTop: 12, flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
                  {SETTINGS_SECTIONS.map((section) => {
                    const active = visibleSettingsSections[section.id]
                    return (
                      <Pressable
                        key={section.id}
                        onPress={() => void toggleSettingsSection(section.id)}
                        style={optionChipStyle(palette, active)}
                      >
                        <Text
                          style={{ color: optionChipTextColor(palette, active), ...typeStyle(12, { weight: "600" }) }}
                        >
                          {section.label}
                        </Text>
                        <Text style={{ marginTop: 4, color: palette.soft, ...typeStyle(11) }}>
                          {active ? "Visible" : "Hidden"}
                        </Text>
                      </Pressable>
                    )
                  })}
                </View>
              </View>
            </SurfaceCard>

            {visibleSettingsSections.interaction ? (
              <SurfaceCard
                eyebrow="Interactions"
                title="Notifications, haptics, gestures"
                description="Control device feedback for approvals, session completions, failures, and gesture-driven message actions."
              >
                <View className="flex-row flex-wrap gap-2">
                  <InfoChip
                    label={notifications.enabled ? "Notifications on" : "Notifications off"}
                    tone={notifications.enabled ? "good" : "neutral"}
                  />
                  <InfoChip
                    label={haptics.enabled ? "Haptics on" : "Haptics off"}
                    tone={haptics.enabled ? "good" : "neutral"}
                  />
                  <InfoChip
                    label={gestures.bubbleSwipeActions ? "Swipe actions on" : "Swipe actions off"}
                    tone={gestures.bubbleSwipeActions ? "accent" : "neutral"}
                  />
                </View>

                <View style={{ marginTop: 16, gap: 12 }}>
                  {(
                    [
                      [
                        "Notifications",
                        notifications,
                        updateNotificationPreference,
                        [
                          ["enabled", "Master switch"],
                          ["sessionReady", "Session ready"],
                          ["permissions", "Permission requests"],
                          ["failures", "Failures"],
                        ],
                      ],
                      [
                        "Haptics",
                        haptics,
                        updateHapticPreference,
                        [
                          ["enabled", "Master switch"],
                          ["send", "Send"],
                          ["commands", "Commands"],
                          ["permissions", "Permissions"],
                          ["errors", "Errors"],
                        ],
                      ],
                      [
                        "Message gestures",
                        gestures,
                        updateGesturePreference,
                        [
                          ["bubbleSwipeActions", "Swipe actions"],
                          ["bubbleLongPressActions", "Long press actions"],
                        ],
                      ],
                    ] as const
                  ).map(([title, values, update, rows]) => (
                    <View
                      key={title}
                      style={{
                        borderRadius: 12,
                        borderWidth: 1,
                        borderColor: hexToRgba(palette.ink, 0.08),
                        backgroundColor: hexToRgba(palette.background, 0.6),
                        padding: 16,
                      }}
                    >
                      <Text style={{ color: palette.muted, ...typeStyle(12, { weight: "500" }) }}>{title}</Text>
                      <View style={{ marginTop: 12, flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
                        {rows.map(([key, label]) => {
                          const active = Boolean(values[key as keyof typeof values])
                          return (
                            <Pressable
                              key={key}
                              onPress={() => void (update as (nextKey: string, next: boolean) => unknown)(key, !active)}
                              style={optionChipStyle(palette, active)}
                            >
                              <Text
                                style={{
                                  color: optionChipTextColor(palette, active),
                                  ...typeStyle(12, { weight: "600" }),
                                }}
                              >
                                {label}
                              </Text>
                              <Text style={{ marginTop: 4, color: palette.soft, ...typeStyle(11) }}>
                                {active ? "On" : "Off"}
                              </Text>
                            </Pressable>
                          )
                        })}
                      </View>
                    </View>
                  ))}
                </View>
              </SurfaceCard>
            ) : null}

            {visibleSettingsSections.connection ? (
              <SurfaceCard
                eyebrow="Server connection"
                title="Primary endpoint"
                description="This hosted endpoint is the execution backbone for sessions, worktrees, approvals, and GitHub publishing."
                tone="panel"
              >
                <View className="gap-3">
                  <TextField
                    label="Server URL"
                    value={url}
                    onChangeText={setUrl}
                    autoCapitalize="none"
                    placeholder="https://your-hosted-nikcli.example.com"
                  />
                  <TextField
                    label="Bearer token"
                    value={token}
                    onChangeText={setToken}
                    autoCapitalize="none"
                    placeholder="Bearer token"
                  />
                  <TextField
                    label="Default server directory"
                    value={directory}
                    onChangeText={setDirectory}
                    autoCapitalize="none"
                    placeholder="Default directory on the hosted server"
                  />
                  <View className="flex-row gap-2">
                    <View className="flex-1">
                      <ActionButton label="Save connection" loading={saving} onPress={() => void saveConnection()} />
                    </View>
                    <View className="flex-1">
                      <ActionButton
                        label="Forget server"
                        variant="secondary"
                        disabled={saving}
                        onPress={() => void forgetHost()}
                      />
                    </View>
                    {currentUser ? (
                      <View className="flex-1">
                        <ActionButton
                          label={`Sign out (${currentUser.display_name || currentUser.username})`}
                          variant="secondary"
                          disabled={saving}
                          onPress={() => {
                            void signOut().then(() => {
                              const { router } = require("expo-router")
                              router.replace("/login")
                            })
                          }}
                        />
                      </View>
                    ) : null}
                  </View>
                </View>
              </SurfaceCard>
            ) : null}

            {visibleSettingsSections.execution ? (
              <SurfaceCard
                eyebrow="GitHub execution"
                title="Choose where GitHub sessions run"
                description="Keep the current server worktree flow or launch GitHub sessions inside a same-server container sandbox while preserving the existing mobile structure."
              >
                <View className="flex-row flex-wrap gap-2">
                  <InfoChip
                    label={
                      containerReady
                        ? `Container ready${containerRuntime ? ` (${containerRuntime})` : ""}`
                        : "Container unavailable"
                    }
                    tone={containerReady ? "good" : "warn"}
                  />
                  <InfoChip
                    label={selectedExecutionTarget === "container" ? "Container sandbox" : "Local worktree"}
                    tone="accent"
                  />
                </View>

                <View className="mt-4 flex-row gap-2">
                  <Pressable
                    onPress={() => setSelectedExecutionTarget("local")}
                    style={[
                      optionChipStyle(palette, selectedExecutionTarget === "local"),
                      { flex: 1, minWidth: 0, borderRadius: 18, padding: 12 },
                    ]}
                  >
                    <Text
                      style={{
                        color: optionChipTextColor(palette, selectedExecutionTarget === "local"),
                        ...typeStyle(14, { weight: "600" }),
                      }}
                    >
                      Local worktree
                    </Text>
                    <Text style={{ marginTop: 4, color: palette.soft, ...typeStyle(12) }}>
                      Same behavior as now: server repo, server git, fastest path to publish.
                    </Text>
                  </Pressable>

                  <Pressable
                    onPress={() => {
                      if (containerReady) setSelectedExecutionTarget("container")
                    }}
                    disabled={!containerReady}
                    style={[
                      optionChipStyle(palette, selectedExecutionTarget === "container"),
                      { flex: 1, minWidth: 0, borderRadius: 18, padding: 12, opacity: containerReady ? 1 : 0.5 },
                    ]}
                  >
                    <Text
                      style={{
                        color: optionChipTextColor(palette, selectedExecutionTarget === "container"),
                        ...typeStyle(14, { weight: "600" }),
                      }}
                    >
                      Container sandbox
                    </Text>
                    <Text style={{ marginTop: 4, color: palette.soft, ...typeStyle(12) }}>
                      Runs GitHub session execution inside a same-server container while keeping the worktree publish
                      flow.
                    </Text>
                  </Pressable>
                </View>

                <Text style={{ marginTop: 12, color: palette.soft, ...typeStyle(12) }}>
                  {containerReady
                    ? "Recommended when you want stronger execution isolation without changing how PRs and cleanup work."
                    : "Install Docker or Podman on the server to unlock container-backed GitHub sessions."}
                </Text>
              </SurfaceCard>
            ) : null}

            {visibleSettingsSections.advanced ? (
              <SurfaceCard
                eyebrow="Advanced fallback"
                title="Manual token access"
                description="Use only when OAuth is unavailable or when you need a dedicated service token for a hardened environment."
                tone="panel"
              >
                <View className="flex-row flex-wrap gap-2">
                  <InfoChip label={advancedOpen ? "Expanded" : "Hidden"} tone={advancedOpen ? "accent" : "neutral"} />
                  <InfoChip label="Stored on host" />
                </View>
                <View className="mt-4">
                  <ActionButton
                    label={advancedOpen ? "Hide manual token form" : "Show manual token form"}
                    variant="secondary"
                    onPress={() => setAdvancedOpen((value) => !value)}
                  />
                </View>

                {advancedOpen ? (
                  <View className="mt-4 gap-3">
                    <TextField
                      value={githubToken}
                      onChangeText={setGithubToken}
                      autoCapitalize="none"
                      placeholder="ghp_..."
                      label="GitHub token"
                    />
                    <ActionButton
                      label="Save manual GitHub token"
                      variant="secondary"
                      loading={saving}
                      disabled={!githubToken.trim()}
                      onPress={() => void connectGithubWithToken()}
                    />
                  </View>
                ) : null}
              </SurfaceCard>
            ) : null}

            {bootstrapLoading ? (
              <View
                style={{
                  alignItems: "center",
                  borderRadius: 12,
                  borderWidth: 1,
                  borderColor: hexToRgba(palette.ink, 0.08),
                  backgroundColor: palette.surface,
                  padding: 16,
                }}
              >
                <ActivityIndicator color={palette.accent} />
                <Text style={{ marginTop: 12, color: palette.soft, ...typeStyle(14) }}>
                  Refreshing host and GitHub posture…
                </Text>
              </View>
            ) : null}

            <Modal
              visible={themePickerOpen}
              transparent
              animationType="slide"
              onRequestClose={() => setThemePickerOpen(false)}
            >
              <View style={{ flex: 1, justifyContent: "flex-end", backgroundColor: hexToRgba(palette.ink, 0.46) }}>
                <Pressable
                  style={{ flex: 1 }}
                  onPress={() => setThemePickerOpen(false)}
                  accessibilityLabel="Dismiss theme picker"
                />
                <View
                  style={{
                    borderTopLeftRadius: 24,
                    borderTopRightRadius: 24,
                    borderCurve: "continuous",
                    borderTopWidth: 1,
                    borderColor: hexToRgba(palette.ink, 0.08),
                    backgroundColor: palette.surface,
                    paddingHorizontal: 16,
                    paddingTop: 12,
                    paddingBottom: 32,
                  }}
                >
                  <View
                    style={{
                      alignSelf: "center",
                      marginBottom: 16,
                      height: 4,
                      width: 40,
                      borderRadius: 999,
                      backgroundColor: hexToRgba(palette.ink, 0.16),
                    }}
                  />
                  <Text
                    style={{
                      marginBottom: 16,
                      textAlign: "center",
                      color: palette.ink,
                      ...typeStyle(18, { weight: "600" }),
                    }}
                  >
                    Choose theme
                  </Text>
                  <ScrollView
                    style={{ maxHeight: 400 }}
                    showsVerticalScrollIndicator={false}
                    contentContainerStyle={{ paddingBottom: 20 }}
                  >
                    {THEME_LIST.map((theme) => {
                      const isSelected = theme.id === themeId
                      return (
                        <Pressable
                          key={theme.id}
                          onPress={() => {
                            setTheme(theme.id)
                            setThemePickerOpen(false)
                          }}
                          accessibilityRole="button"
                          accessibilityState={{ selected: isSelected }}
                          style={{
                            marginHorizontal: 4,
                            marginVertical: 4,
                            minHeight: 44,
                            flexDirection: "row",
                            alignItems: "center",
                            justifyContent: "space-between",
                            borderRadius: 12,
                            paddingHorizontal: 16,
                            paddingVertical: 12,
                            backgroundColor: isSelected ? hexToRgba(palette.accent, 0.12) : "transparent",
                          }}
                        >
                          <View>
                            <Text
                              style={{
                                color: isSelected ? palette.accent : palette.ink,
                                ...typeStyle(14, { weight: "600" }),
                              }}
                            >
                              {theme.name}
                            </Text>
                            {theme.author ? (
                              <Text style={{ marginTop: 4, color: palette.muted, ...typeStyle(12) }}>
                                by {theme.author}
                              </Text>
                            ) : null}
                          </View>
                          {isSelected ? (
                            <View
                              style={{
                                width: 24,
                                height: 24,
                                alignItems: "center",
                                justifyContent: "center",
                                borderRadius: 12,
                                backgroundColor: hexToRgba(palette.accent, 0.19),
                              }}
                            >
                              <Text style={{ color: palette.accent, fontWeight: "700" }}>✓</Text>
                            </View>
                          ) : null}
                        </Pressable>
                      )
                    })}
                  </ScrollView>
                </View>
              </View>
            </Modal>
          </View>
        }
      />
    </View>
  )
}
