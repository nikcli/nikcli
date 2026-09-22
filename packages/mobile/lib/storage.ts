import * as SecureStore from "expo-secure-store"
import { parseStoredTokenTriple, type OAuthTokenTriple } from "./oauth-core"
import type {
  AppPreferences,
  ComposerPreferences,
  GesturePreferences,
  HapticPreferences,
  NotificationPreferences,
  PromptPreset,
  SecurityPreferences,
  ServerConfig,
  SettingsSectionID,
} from "./types"
import { DEFAULT_WALLPAPER, normalizeWallpaper } from "./wallpaper"

export { normalizeWallpaper }

const SERVER_CONFIG_KEY = "nikcli_server_config"
const APP_PREFERENCES_KEY = "nikcli_app_preferences"
const USER_TOKEN_KEY = "nikcli_user_token"
const OAUTH_TOKENS_KEY = "nikcli_oauth_tokens"
const OAUTH_ISSUER_KEY = "nikcli_oauth_issuer"
const REMEMBERED_USER_KEY = "nikcli_remembered_user"
const LIVE_ACTIVITY_REGISTRY_KEY = "nikcli_live_activity_registry"
const THEME_ID_KEY = "nikcli_theme_id"
const COLOR_SCHEME_KEY = "nikcli_color_scheme"
const TELEPORT_TARGET_KEY = "nikcli_teleport_target"
const SESSION_SEEN_KEY = "nikcli_session_seen"
const GITHUB_DEVICE_AUTH_PENDING_KEY = "nikcli_github_device_auth_pending"

export type TeleportTarget = { url: string; token: string }

export type GithubDeviceAuthPending = {
  deviceCode: string
  userCode: string
  verificationUri: string
  verificationUriComplete?: string
  expiresAt: number
  interval: number
}

export type StoredColorScheme = "light" | "dark" | "system"

export async function getThemePreferences(): Promise<{
  themeId: string | null
  colorScheme: StoredColorScheme | null
}> {
  const [themeId, colorScheme] = await Promise.all([
    SecureStore.getItemAsync(THEME_ID_KEY),
    SecureStore.getItemAsync(COLOR_SCHEME_KEY),
  ])
  return {
    themeId,
    colorScheme: colorScheme === "light" || colorScheme === "dark" || colorScheme === "system" ? colorScheme : null,
  }
}

export async function setStoredTheme(themeId: string): Promise<void> {
  await SecureStore.setItemAsync(THEME_ID_KEY, themeId)
}

export async function setStoredColorScheme(colorScheme: StoredColorScheme): Promise<void> {
  await SecureStore.setItemAsync(COLOR_SCHEME_KEY, colorScheme)
}

export type RememberedUser = {
  email: string
  timestamp: number
}

export async function getRememberedUser(): Promise<RememberedUser | null> {
  const raw = await SecureStore.getItemAsync(REMEMBERED_USER_KEY)
  if (!raw) return null
  try {
    return JSON.parse(raw) as RememberedUser
  } catch {
    return null
  }
}

export async function setRememberedUser(email: string): Promise<void> {
  await SecureStore.setItemAsync(REMEMBERED_USER_KEY, JSON.stringify({ email, timestamp: Date.now() }))
}

export async function clearRememberedUser(): Promise<void> {
  await SecureStore.deleteItemAsync(REMEMBERED_USER_KEY)
}

export async function getUserToken(): Promise<string | null> {
  return SecureStore.getItemAsync(USER_TOKEN_KEY)
}

export async function setUserToken(token: string): Promise<void> {
  await SecureStore.setItemAsync(USER_TOKEN_KEY, token)
}

export async function clearUserToken(): Promise<void> {
  await SecureStore.deleteItemAsync(USER_TOKEN_KEY)
}

export async function getOAuthTokens(): Promise<OAuthTokenTriple | null> {
  return parseStoredTokenTriple(await SecureStore.getItemAsync(OAUTH_TOKENS_KEY))
}

export async function getOAuthIssuer(): Promise<string | null> {
  return SecureStore.getItemAsync(OAUTH_ISSUER_KEY)
}

export async function setOAuthSession(tokens: OAuthTokenTriple, issuer: string): Promise<void> {
  await Promise.all([
    SecureStore.setItemAsync(OAUTH_TOKENS_KEY, JSON.stringify(tokens)),
    SecureStore.setItemAsync(OAUTH_ISSUER_KEY, issuer),
  ])
}

export async function clearOAuthSession(): Promise<void> {
  await Promise.all([SecureStore.deleteItemAsync(OAUTH_TOKENS_KEY), SecureStore.deleteItemAsync(OAUTH_ISSUER_KEY)])
}

const DEFAULT_SETTINGS_SECTIONS: Record<SettingsSectionID, boolean> = {
  profile: true,
  interaction: true,
  commands: true,
  memories: true,
  connection: true,
  execution: true,
  providers: true,
  github: true,
  mcp: true,
  skills: true,
  advanced: true,
  connectors: true,
  agents: true,
  tokens: true,
  routines: true,
  plugins: true,
  permissions: true,
}

const DEFAULT_NOTIFICATION_PREFERENCES: NotificationPreferences = {
  enabled: false,
  sessionReady: true,
  permissions: true,
  failures: true,
}

const DEFAULT_HAPTIC_PREFERENCES: HapticPreferences = {
  enabled: true,
  send: true,
  commands: true,
  permissions: true,
  errors: true,
}

const DEFAULT_GESTURE_PREFERENCES: GesturePreferences = {
  bubbleSwipeActions: true,
  bubbleLongPressActions: true,
}

const DEFAULT_COMPOSER_PREFERENCES: ComposerPreferences = {
  defaultMode: "code",
  autoFollowTranscript: true,
  slashSuggestions: true,
}

export const DEFAULT_SECURITY_PREFERENCES: SecurityPreferences = {
  biometricsEnabled: false,
  lockOnBackground: true,
  confirmSensitiveActions: true,
}

const DEFAULT_PROMPT_PRESETS: PromptPreset[] = [
  {
    id: "preset-review",
    title: "Review current work",
    prompt: "Review the current changes, call out risks, and propose the smallest safe next steps.",
    mode: "plan",
  },
  {
    id: "preset-fix",
    title: "Fix latest error",
    prompt: "Investigate the latest failure, explain the root cause, and apply the smallest correct fix.",
    mode: "code",
  },
  {
    id: "preset-publish",
    title: "Prepare publish",
    prompt: "Check the diff, summarize the work, and get this session ready to publish safely.",
    mode: "plan",
  },
]

function defaultPreferences(): AppPreferences {
  return {
    themeMode: "system",
    visibleSettingsSections: DEFAULT_SETTINGS_SECTIONS,
    notifications: DEFAULT_NOTIFICATION_PREFERENCES,
    haptics: DEFAULT_HAPTIC_PREFERENCES,
    gestures: DEFAULT_GESTURE_PREFERENCES,
    composer: DEFAULT_COMPOSER_PREFERENCES,
    promptPresets: DEFAULT_PROMPT_PRESETS,
    wallpaper: DEFAULT_WALLPAPER,
    security: DEFAULT_SECURITY_PREFERENCES,
    tipsHidden: false,
    mathEnabled: false,
  }
}

function envDefault(): ServerConfig | null {
  const url = process.env.EXPO_PUBLIC_NIKCLI_SERVER_URL
  if (!url) return null
  return {
    url,
    username: process.env.EXPO_PUBLIC_NIKCLI_USERNAME || undefined,
    password: process.env.EXPO_PUBLIC_NIKCLI_PASSWORD || undefined,
  }
}

export async function getServerConfig(): Promise<ServerConfig | null> {
  const raw = await SecureStore.getItemAsync(SERVER_CONFIG_KEY)
  if (!raw) return envDefault()
  try {
    return JSON.parse(raw) as ServerConfig
  } catch {
    return envDefault()
  }
}

export async function setServerConfig(config: ServerConfig): Promise<void> {
  await SecureStore.setItemAsync(SERVER_CONFIG_KEY, JSON.stringify(config))
}

export async function clearServerConfig(): Promise<void> {
  await SecureStore.deleteItemAsync(SERVER_CONFIG_KEY)
}

export async function getTeleportTarget(): Promise<TeleportTarget | null> {
  const raw = await SecureStore.getItemAsync(TELEPORT_TARGET_KEY)
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as Partial<TeleportTarget>
    if (typeof parsed.url === "string" && typeof parsed.token === "string") {
      return { url: parsed.url, token: parsed.token }
    }
    return null
  } catch {
    return null
  }
}

export async function setTeleportTarget(target: TeleportTarget): Promise<void> {
  await SecureStore.setItemAsync(TELEPORT_TARGET_KEY, JSON.stringify(target))
}

/**
 * Survives the app process being killed while the user is away approving GitHub
 * device auth in a browser tab — Android reclaims backgrounded RN JS far more
 * aggressively than iOS, which otherwise loses the whole in-progress flow.
 */
export async function getGithubDeviceAuthPending(): Promise<GithubDeviceAuthPending | null> {
  const raw = await SecureStore.getItemAsync(GITHUB_DEVICE_AUTH_PENDING_KEY)
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as Partial<GithubDeviceAuthPending>
    if (
      typeof parsed.deviceCode === "string" &&
      typeof parsed.userCode === "string" &&
      typeof parsed.verificationUri === "string" &&
      typeof parsed.expiresAt === "number" &&
      typeof parsed.interval === "number"
    ) {
      return {
        deviceCode: parsed.deviceCode,
        userCode: parsed.userCode,
        verificationUri: parsed.verificationUri,
        verificationUriComplete: parsed.verificationUriComplete,
        expiresAt: parsed.expiresAt,
        interval: parsed.interval,
      }
    }
    return null
  } catch {
    return null
  }
}

export async function setGithubDeviceAuthPending(flow: GithubDeviceAuthPending): Promise<void> {
  await SecureStore.setItemAsync(GITHUB_DEVICE_AUTH_PENDING_KEY, JSON.stringify(flow))
}

export async function clearGithubDeviceAuthPending(): Promise<void> {
  await SecureStore.deleteItemAsync(GITHUB_DEVICE_AUTH_PENDING_KEY)
}

export async function getAppPreferences(): Promise<AppPreferences> {
  const raw = await SecureStore.getItemAsync(APP_PREFERENCES_KEY)
  if (!raw) return defaultPreferences()
  try {
    const parsed = JSON.parse(raw) as Partial<AppPreferences>
    return {
      themeMode: parsed.themeMode === "light" || parsed.themeMode === "dark" ? parsed.themeMode : "system",
      visibleSettingsSections: {
        ...DEFAULT_SETTINGS_SECTIONS,
        ...(parsed.visibleSettingsSections ?? {}),
      },
      notifications: {
        ...DEFAULT_NOTIFICATION_PREFERENCES,
        ...(parsed.notifications ?? {}),
      },
      haptics: {
        ...DEFAULT_HAPTIC_PREFERENCES,
        ...(parsed.haptics ?? {}),
      },
      gestures: {
        ...DEFAULT_GESTURE_PREFERENCES,
        ...(parsed.gestures ?? {}),
      },
      composer: {
        ...DEFAULT_COMPOSER_PREFERENCES,
        ...(parsed.composer ?? {}),
      },
      promptPresets: Array.isArray(parsed.promptPresets)
        ? parsed.promptPresets.filter(
            (item): item is PromptPreset =>
              typeof item === "object" &&
              item !== null &&
              typeof item.id === "string" &&
              typeof item.title === "string" &&
              typeof item.prompt === "string" &&
              (item.mode === "plan" || item.mode === "code"),
          )
        : DEFAULT_PROMPT_PRESETS,
      wallpaper: normalizeWallpaper(parsed.wallpaper),
      security: {
        ...DEFAULT_SECURITY_PREFERENCES,
        ...(parsed.security ?? {}),
      },
      tipsHidden: parsed.tipsHidden === true,
      mathEnabled: parsed.mathEnabled === true,
    }
  } catch {
    return defaultPreferences()
  }
}

// Serialize preference writes so a quick succession of toggles (e.g. user
// changes theme and notifications within a few ms) does not race — without
// this, two callers both call getAppPreferences() to compose a delta, race
// to setItemAsync the full document, and the last writer wins for any field
// touched by both. Same chain technique as lib/config-writer.ts.
const prefsChain: { chain: Promise<unknown> } = { chain: Promise.resolve() }

export interface PatchAppPreferences {
  /**
   * Async transformation that receives the latest persisted preferences and
   * returns the new full document to persist. Returning a Promise is
   * allowed so callers may merge async data (e.g. resolve a default).
   */
  (current: AppPreferences): AppPreferences | Promise<AppPreferences>
}

export function setAppPreferencesWith(merge: PatchAppPreferences): Promise<AppPreferences> {
  const next = prefsChain.chain.then(async () => {
    const current = (await getAppPreferences()) as AppPreferences
    const updated = await merge(current)
    await SecureStore.setItemAsync(APP_PREFERENCES_KEY, JSON.stringify(updated))
    return updated
  })
  prefsChain.chain = next.catch(() => undefined)
  return next
}

export async function setAppPreferences(preferences: AppPreferences): Promise<void> {
  await SecureStore.setItemAsync(APP_PREFERENCES_KEY, JSON.stringify(preferences))
}

export async function getLiveActivityRegistry(): Promise<Record<string, string>> {
  const raw = await SecureStore.getItemAsync(LIVE_ACTIVITY_REGISTRY_KEY)
  if (!raw) return {}

  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>
    return Object.fromEntries(
      Object.entries(parsed).filter(
        (entry): entry is [string, string] => typeof entry[0] === "string" && typeof entry[1] === "string",
      ),
    )
  } catch {
    return {}
  }
}

/** Last time the user opened each session — drives unread dots and the "New" prefix. */
export async function getSessionSeen(): Promise<Record<string, number>> {
  const raw = await SecureStore.getItemAsync(SESSION_SEEN_KEY)
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>
    return Object.fromEntries(
      Object.entries(parsed).filter(
        (entry): entry is [string, number] => typeof entry[0] === "string" && typeof entry[1] === "number",
      ),
    )
  } catch {
    return {}
  }
}

export async function setSessionSeen(seen: Record<string, number>): Promise<void> {
  await SecureStore.setItemAsync(SESSION_SEEN_KEY, JSON.stringify(seen))
}

export async function markSessionSeen(sessionID: string, at = Date.now()): Promise<Record<string, number>> {
  const current = await getSessionSeen()
  const next = { ...current, [sessionID]: at }
  await setSessionSeen(next)
  return next
}

export async function setLiveActivityRegistry(registry: Record<string, string>): Promise<void> {
  if (!Object.keys(registry).length) {
    await SecureStore.deleteItemAsync(LIVE_ACTIVITY_REGISTRY_KEY)
    return
  }

  await SecureStore.setItemAsync(LIVE_ACTIVITY_REGISTRY_KEY, JSON.stringify(registry))
}
