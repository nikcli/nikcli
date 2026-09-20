import { useScrollAcceleration } from "@tui/util/scroll"
import { TextAttributes, type TextareaRenderable } from "@opentui/core"
import { batch, createMemo, createSignal, For, onMount, Show, Switch, Match } from "solid-js"
import { createStore } from "solid-js/store"
import { useKeyboard, useTerminalDimensions } from "@opentui/solid"
import { useTheme } from "@tui/context/theme"
import { useDialog, type DialogContext } from "@tui/ui/dialog"
import { DialogProvider as DialogProviderList } from "@tui/component/dialog-provider"
import { DialogAccountLogin } from "@tui/component/dialog-account-login"
import { Spinner } from "@tui/component/spinner"
import { Global } from "@nikcli-ai/util/global"
import { useSync } from "@tui/context/sync"
import { useSDK } from "@tui/context/sdk"
import { useToast } from "@tui/ui/toast"
import { entries, sortBy } from "remeda"
import { ELEVENLABS_VOICES_LIST, elevenLabsProvider } from "@nikcli-ai/util/tts/elevenlabs"
import { OPENROUTER_VOICES_LIST, openRouterProvider } from "@nikcli-ai/util/tts/openrouter"
import { ttsRegistry, type TTSVoice } from "@nikcli-ai/util/tts/provider"
import { DialogPrompt } from "@tui/ui/dialog-prompt"
import path from "path"
import fs from "fs/promises"

// Register TTS providers in the registry so we can enumerate them in the
// onboarding wizard. The dedicated speak dialog does the same on import, but
// the wizard must work even if DialogSpeakModel has not been mounted yet.
ttsRegistry.register(elevenLabsProvider)
ttsRegistry.register(openRouterProvider)

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  if (
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof (error as { message?: unknown }).message === "string"
  ) {
    return (error as { message: string }).message
  }
  return String(error)
}

// ─── Shared primitives ────────────────────────────────────────────────────────

function SectionLabel(props: { title: string }) {
  const { theme } = useTheme()
  return (
    <text fg={theme.accent.alt} attributes={TextAttributes.BOLD}>
      {props.title}
    </text>
  )
}

function BulletRow(props: { text: string }) {
  const { theme } = useTheme()
  return (
    <box flexDirection="row" gap={1}>
      <text flexShrink={0} fg={theme.status.success.fg}>
        {"●"}
      </text>
      <text fg={theme.foreground.default} flexShrink={1} wrapMode="word">
        {props.text}
      </text>
    </box>
  )
}

function TwoColRow(props: { width: number; label: string; desc: string; labelFg?: string }) {
  const { theme } = useTheme()
  return (
    <box flexDirection="row">
      <box width={props.width} flexShrink={0}>
        <text fg={(props.labelFg as any) ?? theme.accent.fg}>{props.label}</text>
      </box>
      <text fg={theme.foreground.muted} flexShrink={1} wrapMode="word">
        {props.desc}
      </text>
    </box>
  )
}

// ─── Step breadcrumb ──────────────────────────────────────────────────────────

const STEP_NAMES = ["Welcome", "Account", "Filesystem", "AI provider", "Extras", "Image", "TTS", "Remote", "Test"]

// Step indices — keep in sync with STEP_NAMES above
const STEP = {
  WELCOME: 0,
  ACCOUNT: 1,
  FILESYSTEM: 2,
  AI_PROVIDER: 3,
  EXTRAS: 4,
  IMAGE: 5,
  TTS: 6,
  REMOTE: 7,
  TEST: 8,
} as const

type FeatureKey = "image" | "tts" | "remote"

function WizardBreadcrumb(props: { current: number; total: number }) {
  const { theme } = useTheme()
  return (
    <box flexDirection="row" flexWrap="wrap">
      <For each={STEP_NAMES}>
        {(name, i) => (
          <Show when={i() < props.total}>
            <text
              fg={i() === props.current ? theme.accent.fg : theme.border.subtle}
              attributes={i() === props.current ? TextAttributes.BOLD : undefined}
            >
              {i() > 0 ? "  ·  " : ""}
              {i() + 1}. {name}
            </text>
          </Show>
        )}
      </For>
    </box>
  )
}

// ─── Step 1: Welcome ──────────────────────────────────────────────────────────

const CAPABILITIES = [
  "Read, write and refactor code across your entire project",
  "Execute shell commands, run tests and manage processes",
  "Review git diffs, stage changes and manage commits",
  "Search the web and fetch live documentation on demand",
  "Work in parallel sessions across multiple workspaces",
  "Run proactive background agents via Brain sessions",
  "Extend capabilities via MCP server integrations",
]

const CONCEPTS = [
  {
    label: "Sessions",
    desc: "Persistent AI conversations with full access to your codebase, files and tools.",
  },
  {
    label: "Providers",
    desc: "AI services you connect (Anthropic, OpenAI, Google…). At least one required.",
  },
  {
    label: "Agents",
    desc: "AI personas with custom system prompts, skills and model configurations.",
  },
  {
    label: "Brain",
    desc: "Background AI that reviews sessions and builds project knowledge over time.",
  },
  {
    label: "MCP",
    desc: "Model Context Protocol — wire in external tools, databases and APIs.",
  },
  {
    label: "Commands",
    desc: "Ctrl+P or / in the prompt — access every feature, setting and navigation action.",
  },
]

function WelcomeContent() {
  const { theme } = useTheme()
  return (
    <box gap={2}>
      <text fg={theme.foreground.muted} wrapMode="word">
        A terminal-native AI coding assistant. Chat with AI models, run autonomous agents and automate development tasks
        — all without leaving your terminal.
      </text>
      <box gap={1}>
        <SectionLabel title="What you can do" />
        <box gap={0}>
          <For each={CAPABILITIES}>{(item) => <BulletRow text={item} />}</For>
        </box>
      </box>
      <box gap={1}>
        <SectionLabel title="Core concepts" />
        <box gap={1}>
          <For each={CONCEPTS}>{(c) => <TwoColRow width={12} label={c.label} desc={c.desc} />}</For>
        </box>
      </box>
    </box>
  )
}

// ─── Step 3: Filesystem Footprint ─────────────────────────────────────────────

function shortenPath(absPath: string): string {
  const home = Global.Path.home
  if (absPath.startsWith(home)) return "~" + absPath.slice(home.length)
  return absPath
}

function FsRow(props: {
  indent: number
  path: string
  desc: string
  icon?: string
  iconFg?: string
  sensitive?: boolean
  ephemeral?: boolean
}) {
  const { theme } = useTheme()
  const icon = props.icon ?? (props.sensitive ? "●" : props.ephemeral ? "◦" : "·")
  const iconFg = props.iconFg ?? (props.sensitive ? theme.status.warning.fg : theme.foreground.muted)
  const pathFg = theme.foreground.default
  const indent = "  ".repeat(props.indent)
  return (
    <box flexDirection="row">
      <text flexShrink={0} fg={theme.border.subtle}>
        {indent}
      </text>
      <text flexShrink={0} fg={iconFg}>
        {icon}{" "}
      </text>
      <text fg={pathFg} attributes={TextAttributes.BOLD}>
        {props.path}
      </text>
      <text flexShrink={0}> </text>
      <text fg={theme.foreground.muted} flexShrink={1} wrapMode="word">
        {props.desc}
      </text>
    </box>
  )
}

function FsSectionHeader(props: { title: string; subtitle: string }) {
  const { theme } = useTheme()
  return (
    <box gap={0}>
      <text fg={theme.accent.alt} attributes={TextAttributes.BOLD}>
        {props.title}
      </text>
      <text fg={theme.foreground.muted}>{props.subtitle}</text>
    </box>
  )
}

const dataRoot = shortenPath(Global.Path.data)
const configRoot = shortenPath(Global.Path.config)
const cacheRoot = shortenPath(Global.Path.cache)
const stateRoot = shortenPath(Global.Path.state)

function FilesystemContent() {
  const { theme } = useTheme()
  return (
    <box gap={2}>
      <text fg={theme.foreground.muted} wrapMode="word">
        Nikcli stores all data under standard XDG directories. Nothing hidden outside these locations. All data stays on
        your machine — no telemetry.
      </text>

      {/* ── Data ─────────────────────────────────────────────────── */}
      <box gap={1}>
        <FsSectionHeader title="Application Data" subtitle="Persistent data: sessions, auth, databases" />
        <FsRow indent={0} path={`${dataRoot}/`} desc="Data root directory" />
        <FsRow indent={1} path="bin/" desc="Binary installation (curl method)" />
        <FsRow indent={1} path="log/" desc="Application log files" />
        <FsRow indent={1} path="storage/" desc="Sessions, messages, and content" />
        <FsRow indent={2} path="session/" desc="Session metadata per project" />
        <FsRow indent={2} path="message/" desc="Message history" />
        <FsRow indent={2} path="part/" desc="Tool outputs and responses" />
        <FsRow indent={1} path="plans/" desc="Agent planning documents (.md)" />
        <FsRow indent={1} path="snapshot/" desc="Project snapshots" />
        <FsRow indent={1} path="worktree/" desc="Worktree data" />
        <FsRow indent={1} path="sync/" desc="Synchronization data" />
        <FsRow indent={1} path="auth.json" desc="API keys and credentials" sensitive />
        <FsRow indent={1} path="accounts.db" desc="User account database" sensitive />
        <FsRow indent={1} path="workspaces.db" desc="Workspace database" sensitive />
        <FsRow indent={1} path="connectors-auth.json" desc="Connector auth tokens" sensitive />
      </box>

      {/* ── Config ───────────────────────────────────────────────── */}
      <box gap={1}>
        <FsSectionHeader title="Configuration" subtitle="Settings files — persisted across updates" />
        <FsRow indent={0} path={`${configRoot}/`} desc="Config root directory" />
        <FsRow indent={1} path="nikcli.json" desc="Global config: provider, model, agent defaults" />
        <FsRow indent={1} path="tui.json" desc="TUI config: theme, keybinds, plugins" />
        <FsRow indent={1} path="AGENTS.md" desc="Global AI system instructions" />
        <FsRow indent={1} path="skills/" desc="Installed agent skills" />
      </box>

      {/* ── Cache & State ────────────────────────────────────────── */}
      <box gap={1}>
        <FsSectionHeader title="Cache & Runtime State" subtitle="Temporary data — safe to delete anytime" />
        <FsRow indent={0} path={`${cacheRoot}/`} desc="Cache — cleared on version upgrades" ephemeral />
        <FsRow indent={0} path={`${stateRoot}/`} desc="Runtime state directory" ephemeral />
        <FsRow indent={1} path="locks/" desc="Concurrency locks" />
        <FsRow indent={1} path="prompt-history.jsonl" desc="Prompt history" />
      </box>

      {/* ── Project ──────────────────────────────────────────────── */}
      <box gap={1}>
        <FsSectionHeader
          title="Project Directory (optional)"
          subtitle="Created in your repo when you customize a project"
        />
        <FsRow indent={0} path=".nikcli/" desc="Project config directory" />
        <FsRow indent={1} path="commands/" desc="Custom slash commands (.md)" />
        <FsRow indent={1} path="agents/" desc="Custom AI agents (.md)" />
        <FsRow indent={1} path="plugins/" desc="Local plugins (.ts, .js)" />
        <FsRow indent={1} path="package.json" desc="Plugin dependencies" />
        <FsRow indent={1} path=".gitignore" desc="Version control exclusions" />
        <FsRow indent={0} path="nikcli.json" desc="Per-project settings override" />
      </box>

      {/* ── Legend ───────────────────────────────────────────────── */}
      <box>
        <text fg={theme.foreground.muted} wrapMode="word">
          <span style={{ fg: theme.status.warning.fg }}>● sensitive</span>
          {"  "}
          <span style={{ fg: theme.foreground.muted }}>◦ ephemeral (safe to delete)</span>
          {"  "}
          <span style={{ fg: theme.foreground.muted }}>· normal</span>
        </text>
      </box>
    </box>
  )
}

// ─── Step 4: Connect provider ─────────────────────────────────────────────────

const PROVIDERS_INFO = [
  {
    name: "Nikcli Zen",
    desc: "All top models with a single API key — recommended for new users",
    recommended: true,
  },
  {
    name: "Anthropic",
    desc: "Claude Sonnet, Haiku, Opus — best overall for coding tasks",
  },
  { name: "OpenAI", desc: "GPT-4o, o3, o1 — versatile and widely supported" },
  {
    name: "Google",
    desc: "Gemini 2.0 Flash and Pro — fast and cost-effective",
  },
  {
    name: "GitHub Copilot",
    desc: "Claude + GPT-4o via your existing GitHub account",
  },
  {
    name: "Groq",
    desc: "Ultra-fast inference for Llama, Mixtral and open models",
  },
  {
    name: "Mistral",
    desc: "Mistral Large, Codestral — leading European AI provider",
  },
  {
    name: "Ollama",
    desc: "Run open-source models locally — no API key needed",
  },
]

function ProviderContent() {
  const { theme } = useTheme()
  return (
    <box gap={2}>
      <text fg={theme.foreground.muted} wrapMode="word">
        Connect at least one AI provider to start chatting. You can connect multiple providers and switch models at any
        time via Ctrl+P → "Switch model".
      </text>
      <box gap={1}>
        <SectionLabel title="Available providers" />
        <box gap={0}>
          <For each={PROVIDERS_INFO}>
            {(p) => (
              <box flexDirection="row" gap={1}>
                <text flexShrink={0} fg={p.recommended ? theme.status.success.fg : theme.border.subtle}>
                  {p.recommended ? "★" : "·"}
                </text>
                <box width={16} flexShrink={0}>
                  <text
                    fg={p.recommended ? theme.accent.fg : theme.foreground.default}
                    attributes={p.recommended ? TextAttributes.BOLD : undefined}
                  >
                    {p.name}
                  </text>
                </box>
                <text fg={theme.foreground.muted} flexShrink={1} wrapMode="word">
                  {p.desc}
                </text>
              </box>
            )}
          </For>
        </box>
      </box>
      <text fg={theme.foreground.muted} wrapMode="word">
        After setup, add more providers anytime via Ctrl+P → "Connect provider".
      </text>
    </box>
  )
}

function TestContent() {
  const { theme } = useTheme()
  return (
    <box gap={2}>
      <text fg={theme.foreground.muted} wrapMode="word">
        Quick sanity check: we verify a provider is connected and ready to accept a request. This catches a mis-typed
        API key or expired token before you send your first real prompt.
      </text>
      <TestResult />
    </box>
  )
}

/**
 * Live "checking / ready / failed" badge based on the current provider
 * connection state. Reactive to `sync.data.provider_next.connected` and
 * `sync.data.provider` so the user sees the status update in real time.
 */
function TestResult() {
  const sync = useSync()
  const connected = createMemo(() => sync.data.provider_next.connected)
  const hasModel = createMemo(() => sync.data.provider.some((p) => Object.keys(p.models ?? {}).length > 0))
  const aiOk = createMemo(() => connected().length > 0 && hasModel())
  const imageConfigured = createMemo(
    () => !!(sync.data.config as { image?: { provider?: string; model?: string } } | undefined)?.image?.provider,
  )
  const speakConfigured = createMemo(
    () => !!(sync.data.config as { speak?: { provider?: string } } | undefined)?.speak?.provider,
  )
  const remoteConfigured = createMemo(
    () => (sync.data.config as { remote?: { provider?: string } } | undefined)?.remote?.provider !== undefined,
  )
  return (
    <box gap={1}>
      <SectionLabel title="Status" />
      <StatusRow
        ok={aiOk()}
        label="AI provider"
        detail={aiOk() ? `${connected().length} connected` : "not connected"}
      />
      <StatusRow
        ok={imageConfigured()}
        label="Image generation"
        detail={
          imageConfigured()
            ? (
                sync.data.config as {
                  image?: { provider?: string; model?: string }
                }
              ).image?.provider +
              " · " +
              (
                sync.data.config as {
                  image?: { provider?: string; model?: string }
                }
              ).image?.model
            : "skipped"
        }
      />
      <StatusRow
        ok={speakConfigured()}
        label="Text-to-Speech"
        detail={
          speakConfigured()
            ? ((
                sync.data.config as {
                  speak?: { provider?: string; model?: string }
                }
              )?.speak?.provider ?? "configured")
            : "skipped"
        }
      />
      <StatusRow
        ok={remoteConfigured()}
        label="Remote server"
        detail={
          remoteConfigured()
            ? ((sync.data.config as { remote?: { provider?: string } }).remote?.provider ?? "configured")
            : "skipped"
        }
      />
    </box>
  )
}

function StatusRow(props: { ok: boolean; label: string; detail: string }) {
  const { theme } = useTheme()
  return (
    <box flexDirection="row" gap={1}>
      <text flexShrink={0} fg={props.ok ? theme.status.success.fg : theme.border.subtle}>
        {props.ok ? "●" : "○"}
      </text>
      <box width={20} flexShrink={0}>
        <text
          fg={props.ok ? theme.foreground.default : theme.foreground.muted}
          attributes={props.ok ? TextAttributes.BOLD : undefined}
        >
          {props.label}
        </text>
      </box>
      <text fg={props.ok ? theme.foreground.default : theme.foreground.muted} flexShrink={1} wrapMode="word">
        {props.detail}
      </text>
    </box>
  )
}

// ─── Step 5: Optional extras (feature flags) ──────────────────────────────────

const EXTRAS: Array<{ key: FeatureKey; label: string; desc: string }> = [
  {
    key: "image",
    label: "Image generation",
    desc: "Generate images inside the TUI (Ctrl+P → Image Models). Requires an image-capable provider.",
  },
  {
    key: "tts",
    label: "Text-to-Speech (TTS)",
    desc: "Read assistant replies aloud. ElevenLabs (premium voices) or OpenRouter audio models.",
  },
  {
    key: "remote",
    label: "Remote server (tunnel)",
    desc: "Expose this TUI to a phone or another machine via QR code + tunnel.",
  },
]

function ExtrasContent(props: {
  enabled: Record<FeatureKey, boolean>
  cursor: number
  setCursor: (n: number) => void
  toggle: (k: FeatureKey) => void
}) {
  const { theme } = useTheme()
  return (
    <box gap={2}>
      <text fg={theme.foreground.muted} wrapMode="word">
        Toggle the optional capabilities you want to preconfigure now. You can always wire them up later via
        <span style={{ fg: theme.accent.alt }}> Ctrl+P → Commands </span>
        or the matching slash command. Use <span style={{ fg: theme.accent.fg }}>↑/↓</span> to move,
        <span style={{ fg: theme.accent.fg }}> space/enter </span>
        to toggle, then <span style={{ fg: theme.accent.fg }}>enter on Continue</span>.
      </text>
      <box gap={1}>
        <SectionLabel title="Feature flags" />
        <box gap={0}>
          <For each={EXTRAS}>
            {(item, i) => {
              const isCursor = () => props.cursor === i()
              const isOn = () => props.enabled[item.key]
              return (
                <box flexDirection="row" gap={1}>
                  <text flexShrink={0} fg={isCursor() ? theme.accent.fg : theme.border.subtle}>
                    {isCursor() ? "›" : " "}
                  </text>
                  <text flexShrink={0} fg={isOn() ? theme.status.success.fg : theme.foreground.muted}>
                    {isOn() ? "[x]" : "[ ]"}
                  </text>
                  <box width={22} flexShrink={0}>
                    <text
                      fg={isOn() ? theme.foreground.default : theme.foreground.muted}
                      attributes={isCursor() ? TextAttributes.BOLD : undefined}
                    >
                      {item.label}
                    </text>
                  </box>
                  <text fg={theme.foreground.muted} flexShrink={1} wrapMode="word">
                    {item.desc}
                  </text>
                </box>
              )
            }}
          </For>
        </box>
      </box>
      <box flexDirection="row" gap={1}>
        <text flexShrink={0} fg={props.cursor === EXTRAS.length ? theme.accent.fg : theme.border.subtle}>
          {props.cursor === EXTRAS.length ? "›" : " "}
        </text>
        <text
          fg={props.cursor === EXTRAS.length ? theme.accent.fg : theme.foreground.default}
          attributes={props.cursor === EXTRAS.length ? TextAttributes.BOLD : undefined}
        >
          Continue →
        </text>
      </box>
    </box>
  )
}

// ─── Step 6: Image model ──────────────────────────────────────────────────────

function isImageModelID(modelID: string, info: unknown): boolean {
  const cap = (info as { capabilities?: { output?: { image?: boolean } } } | undefined)?.capabilities?.output?.image
  if (cap === true) return true
  const id = modelID.toLowerCase()
  if (id.includes("dall-e")) return true
  if (id.includes("gpt-image")) return true
  if (id.includes("-image") || id.includes("image-")) return true
  return false
}

function ImageContent(props: {
  cursor: number
  setCursor: (n: number) => void
  onPick: (providerID: string, modelID: string) => void
  onSkip: () => void
}) {
  const { theme } = useTheme()
  const sync = useSync()
  const connectedIds = createMemo(() => new Set(sync.data.provider_next.connected ?? []))

  // Build option list: one entry per image-capable model on a connected provider,
  // plus a "Skip" entry at the end.
  const options = createMemo(() => {
    const items: Array<{
      providerID: string
      modelID: string
      title: string
      provider: string
    }> = []
    for (const provider of sync.data.provider_next.all as any[]) {
      if (!connectedIds().has(provider.id)) continue
      for (const [modelID, info] of entries(provider.models ?? {})) {
        if ((info as { status?: string }).status === "deprecated") continue
        if (!isImageModelID(modelID, info)) continue
        items.push({
          providerID: provider.id,
          modelID,
          title: (info as { name?: string }).name ?? modelID,
          provider: provider.name,
        })
      }
    }
    return sortBy(items, (x) => x.title.toLowerCase())
  })

  return (
    <box gap={2}>
      <text fg={theme.foreground.muted} wrapMode="word">
        Pick the image model Nikcli should use by default for image generation. Skip to configure later via
        <span style={{ fg: theme.accent.alt }}> Ctrl+P → Image Models</span>.
      </text>
      <SectionLabel title={`Available image models (${options().length})`} />
      <box gap={0}>
        <For each={options()}>
          {(item, i) => {
            const isCursor = () => props.cursor === i()
            return (
              <box flexDirection="row" gap={1}>
                <text flexShrink={0} fg={isCursor() ? theme.accent.fg : theme.border.subtle}>
                  {isCursor() ? "›" : " "}
                </text>
                <box width={28} flexShrink={0}>
                  <text
                    fg={isCursor() ? theme.foreground.default : theme.foreground.muted}
                    attributes={isCursor() ? TextAttributes.BOLD : undefined}
                  >
                    {item.title}
                  </text>
                </box>
                <text fg={theme.foreground.muted} flexShrink={1} wrapMode="word">
                  {item.provider}
                </text>
              </box>
            )
          }}
        </For>
        <Show when={options().length === 0}>
          <text fg={theme.foreground.muted}>
            No image-capable models found among your connected providers. Connect OpenAI, Google or xAI first.
          </text>
        </Show>
      </box>
      {/* Skip row */}
      <box flexDirection="row" gap={1}>
        <text flexShrink={0} fg={props.cursor === options().length ? theme.accent.fg : theme.border.subtle}>
          {props.cursor === options().length ? "›" : " "}
        </text>
        <text
          fg={props.cursor === options().length ? theme.accent.fg : theme.foreground.muted}
          attributes={props.cursor === options().length ? TextAttributes.BOLD : undefined}
        >
          Skip — configure later
        </text>
      </box>
    </box>
  )
}

// ─── Step 7: TTS voice ────────────────────────────────────────────────────────

const TTS_PROVIDERS: Array<{
  id: string
  name: string
  desc: string
  voices: () => TTSVoice[] | Promise<TTSVoice[]>
}> = [
  {
    id: "elevenlabs",
    name: "ElevenLabs",
    desc: "Premium neural voices, 19 curated defaults (Rachel, Adam, Bella, …).",
    voices: () => ELEVENLABS_VOICES_LIST,
  },
  {
    id: "openrouter",
    name: "OpenRouter audio",
    desc: "Reuses an existing OpenRouter API key — pay-per-character audio models.",
    voices: () => OPENROUTER_VOICES_LIST,
  },
]

function TTSContent(props: {
  cursor: number
  setCursor: (n: number) => void
  onPick: (providerID: string, voiceId: string, voiceName: string) => void
  onSkip: () => void
  status: string | null
}) {
  const { theme } = useTheme()
  // Two-stage selector flattened into one cursor space: provider 0..N-1,
  // then voices of the highlighted provider, then "skip".
  // For simplicity, we render all provider rows + their voices inline.
  const rows = createMemo(() => {
    const out: Array<
      | { kind: "provider"; provider: (typeof TTS_PROVIDERS)[number] }
      | { kind: "voice"; providerId: string; voice: TTSVoice }
      | { kind: "skip" }
    > = []
    for (const provider of TTS_PROVIDERS) {
      out.push({ kind: "provider", provider })
      const voices = provider.voices()
      if (Array.isArray(voices)) {
        for (const v of voices) out.push({ kind: "voice", providerId: provider.id, voice: v })
      }
    }
    out.push({ kind: "skip" })
    return out
  })

  return (
    <box gap={2}>
      <text fg={theme.foreground.muted} wrapMode="word">
        Choose a Text-to-Speech provider and voice. ElevenLabs needs its own key (you can paste it after selection);
        OpenRouter reuses the key you already entered for the AI provider.
      </text>
      <Show when={props.status}>
        <text fg={theme.status.success.fg}>{props.status}</text>
      </Show>
      <SectionLabel title="TTS providers & voices" />
      <box gap={0}>
        <For each={rows()}>
          {(row, i) => {
            const isCursor = () => props.cursor === i()
            if (row.kind === "provider") {
              return (
                <box flexDirection="row" gap={1}>
                  <text flexShrink={0} fg={isCursor() ? theme.accent.fg : theme.border.subtle}>
                    {isCursor() ? "›" : " "}
                  </text>
                  <text
                    fg={isCursor() ? theme.accent.fg : theme.foreground.default}
                    attributes={isCursor() ? TextAttributes.BOLD : undefined}
                  >
                    {row.provider.name}
                  </text>
                  <text fg={theme.foreground.muted} flexShrink={1} wrapMode="word">
                    {" "}
                    — {row.provider.desc}
                  </text>
                </box>
              )
            }
            if (row.kind === "voice") {
              return (
                <box flexDirection="row" gap={1}>
                  <text flexShrink={0} fg={isCursor() ? theme.accent.fg : theme.border.subtle}>
                    {isCursor() ? "›" : " "}
                  </text>
                  <text flexShrink={0}>{"  "}</text>
                  <box width={20} flexShrink={0}>
                    <text
                      fg={isCursor() ? theme.foreground.default : theme.foreground.muted}
                      attributes={isCursor() ? TextAttributes.BOLD : undefined}
                    >
                      {row.voice.name}
                    </text>
                  </box>
                  <text fg={theme.foreground.muted} flexShrink={1} wrapMode="word">
                    {row.voice.id}
                  </text>
                </box>
              )
            }
            return (
              <box flexDirection="row" gap={1}>
                <text flexShrink={0} fg={isCursor() ? theme.accent.fg : theme.border.subtle}>
                  {isCursor() ? "›" : " "}
                </text>
                <text
                  fg={isCursor() ? theme.accent.fg : theme.foreground.muted}
                  attributes={isCursor() ? TextAttributes.BOLD : undefined}
                >
                  Skip — configure later
                </text>
              </box>
            )
          }}
        </For>
      </box>
    </box>
  )
}

// ─── Step 8: Remote server (tunnel) ───────────────────────────────────────────

const REMOTE_PROVIDERS = [
  {
    id: "localtunnel",
    name: "Localtunnel",
    desc: "Free, zero-config tunnel via localtunnel.me",
  },
  {
    id: "cloudflared",
    name: "Cloudflared",
    desc: "Cloudflare quick tunnel (requires cloudflared CLI)",
  },
  {
    id: "ngrok",
    name: "Ngrok",
    desc: "Ngrok tunnel (requires ngrok auth token)",
  },
  {
    id: "remotosh",
    name: "Remotosh",
    desc: "Remotosh tunnel (requires remotosh CLI)",
  },
  { id: "none", name: "Local only", desc: "No tunnel — use local network IP" },
] as const

function RemoteContent(props: {
  cursor: number
  setCursor: (n: number) => void
  onPick: (providerID: string) => void
  onSkip: () => void
}) {
  const { theme } = useTheme()
  return (
    <box gap={2}>
      <text fg={theme.foreground.muted} wrapMode="word">
        Pick the default tunnel provider used when you start a Remote Session. You can change it any time via
        <span style={{ fg: theme.accent.alt }}> Ctrl+P → Remote Access</span>.
      </text>
      <SectionLabel title="Tunnel providers" />
      <box gap={0}>
        <For each={REMOTE_PROVIDERS}>
          {(p, i) => {
            const isCursor = () => props.cursor === i()
            return (
              <box flexDirection="row" gap={1}>
                <text flexShrink={0} fg={isCursor() ? theme.accent.fg : theme.border.subtle}>
                  {isCursor() ? "›" : " "}
                </text>
                <box width={16} flexShrink={0}>
                  <text
                    fg={isCursor() ? theme.foreground.default : theme.foreground.muted}
                    attributes={isCursor() ? TextAttributes.BOLD : undefined}
                  >
                    {p.name}
                  </text>
                </box>
                <text fg={theme.foreground.muted} flexShrink={1} wrapMode="word">
                  {p.desc}
                </text>
              </box>
            )
          }}
        </For>
        <box flexDirection="row" gap={1}>
          <text flexShrink={0} fg={props.cursor === REMOTE_PROVIDERS.length ? theme.accent.fg : theme.border.subtle}>
            {props.cursor === REMOTE_PROVIDERS.length ? "›" : " "}
          </text>
          <text
            fg={props.cursor === REMOTE_PROVIDERS.length ? theme.accent.fg : theme.foreground.muted}
            attributes={props.cursor === REMOTE_PROVIDERS.length ? TextAttributes.BOLD : undefined}
          >
            Skip — configure later
          </text>
        </box>
      </box>
    </box>
  )
}

const STEP_TITLES = [
  "Welcome to Nikcli",
  "Sign in or create your account",
  "Filesystem Footprint",
  "Connect a provider",
  "Optional extras",
  "Image generation",
  "Text-to-Speech (TTS)",
  "Remote server",
  "Test your setup",
]

// Continue hint for the static (no-list) steps. List-driven steps set their
// own footer hint inline.
const STEP_CONTINUE_LABELS = [
  "sign in on the web",
  "", // account step handles its own status
  "view filesystem",
  "choose provider",
  "configure extras",
  "pick an image model",
  "pick a TTS voice",
  "pick a tunnel provider",
  "finish",
]

function OnboardingWizard(props: { onComplete: () => void }) {
  const { theme } = useTheme()
  const scrollAcceleration = useScrollAcceleration()
  const dialog = useDialog()
  const dimensions = useTerminalDimensions()
  const contentMaxHeight = createMemo(() => Math.max(8, dimensions().height - 12))
  const sdk = useSDK()
  const sync = useSync()
  const toast = useToast()

  const [step, setStep] = createSignal<number>(STEP.WELCOME)
  // Feature flags selected in step EXTRAS — drives which optional config
  // steps get visited.
  const [extras, setExtras] = createStore<Record<FeatureKey, boolean>>({
    image: false,
    tts: false,
    remote: false,
  })

  // Cursor for list-driven steps (extras, image, tts, remote)
  const [extrasCursor, setExtrasCursor] = createSignal(0)
  const [imageCursor, setImageCursor] = createSignal(0)
  const [ttsCursor, setTtsCursor] = createSignal(0)
  const [remoteCursor, setRemoteCursor] = createSignal(0)

  const [ttsStatus, setTtsStatus] = createSignal<string | null>(null)

  // Number of steps we will actually visit, given the enabled extras.
  // Used for the breadcrumb and footer "step X/Y" counter.
  const visibleSteps = createMemo(() => {
    const out: number[] = [STEP.WELCOME, STEP.ACCOUNT, STEP.FILESYSTEM, STEP.AI_PROVIDER, STEP.EXTRAS]
    if (extras.image) out.push(STEP.IMAGE)
    if (extras.tts) out.push(STEP.TTS)
    if (extras.remote) out.push(STEP.REMOTE)
    out.push(STEP.TEST)
    return out
  })

  const totalSteps = createMemo(() => visibleSteps().length)
  const displayIndex = createMemo(() => {
    const idx = visibleSteps().indexOf(step())
    return idx === -1 ? 1 : idx + 1
  })

  // Advance to the next visible step (skipping disabled optional steps).
  const advance = () => {
    setStep((s) => {
      let next = s + 1
      while (next < STEP.TEST) {
        if (next === STEP.IMAGE && !extras.image) {
          next++
          continue
        }
        if (next === STEP.TTS && !extras.tts) {
          next++
          continue
        }
        if (next === STEP.REMOTE && !extras.remote) {
          next++
          continue
        }
        break
      }
      return next
    })
  }

  onMount(() => dialog.setSize("large"))

  // ─── Step persistence side-effects ────────────────────────────────────────

  const persistImage = async (providerID: string, modelID: string) => {
    const result = await sdk.client.config.update({
      payload: { image: { provider: providerID, model: modelID } } as any,
    })
    if ((result as { error?: unknown }).error) {
      const msg = errorMessage((result as { error?: unknown }).error)
      toast.show({
        variant: "error",
        message: `Failed to save image model: ${msg}`,
      })
      return false
    }
    sync.set("config", (result as { data?: any }).data)
    toast.show({
      variant: "success",
      message: `Image model set to ${providerID}/${modelID}`,
    })
    return true
  }

  const persistSpeak = async (providerID: string, voiceId: string, voiceName: string) => {
    const result = await sdk.client.config.update({
      payload: { speak: { provider: providerID, model: voiceId } } as any,
    })
    if ((result as { error?: unknown }).error) {
      const msg = errorMessage((result as { error?: unknown }).error)
      toast.show({
        variant: "error",
        message: `Failed to save TTS voice: ${msg}`,
      })
      return false
    }
    sync.set("config", (result as { data?: any }).data)
    setTtsStatus(`TTS set to ${providerID} · ${voiceName}`)
    toast.show({
      variant: "success",
      message: `TTS voice set to ${voiceName}`,
    })
    return true
  }

  // Persist the ElevenLabs API key by writing it to the same secrets file
  // the speak provider reads on disk. No-op for non-elevenlabs providers.
  const persistElevenLabsKey = async (key: string) => {
    const dir = path.join(Global.Path.config, "secrets")
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(path.join(dir, "elevenlabs-key"), key.trim() + "\n", {
      mode: 0o600,
    })
  }

  const persistRemote = async (providerID: string) => {
    const result = await sdk.client.config.update({
      payload: {
        remote: { provider: providerID, enableTunnel: providerID !== "none" },
      } as any,
    })
    if ((result as { error?: unknown }).error) {
      const msg = errorMessage((result as { error?: unknown }).error)
      toast.show({
        variant: "error",
        message: `Failed to save remote config: ${msg}`,
      })
      return false
    }
    sync.set("config", (result as { data?: any }).data)
    toast.show({
      variant: "success",
      message: `Remote tunnel set to ${providerID}`,
    })
    return true
  }

  // ─── List options used by keyboard nav (must be declared before useKeyboard) ──

  const imageOptions = createMemo(() => {
    const items: Array<{
      providerID: string
      modelID: string
      title: string
      provider: string
    }> = []
    for (const provider of sync.data.provider_next.all as any[]) {
      if (!(sync.data.provider_next.connected ?? []).includes(provider.id)) continue
      for (const [modelID, info] of entries(provider.models ?? {})) {
        if ((info as { status?: string }).status === "deprecated") continue
        if (!isImageModelID(modelID, info)) continue
        items.push({
          providerID: provider.id,
          modelID,
          title: (info as { name?: string }).name ?? modelID,
          provider: provider.name,
        })
      }
    }
    return sortBy(items, (x) => x.title.toLowerCase())
  })

  const ttsRows = createMemo(() => {
    const out: Array<
      | { kind: "provider"; provider: (typeof TTS_PROVIDERS)[number] }
      | { kind: "voice"; providerId: string; voice: TTSVoice }
      | { kind: "skip" }
    > = []
    for (const provider of TTS_PROVIDERS) {
      out.push({ kind: "provider", provider })
      const voices = provider.voices()
      if (Array.isArray(voices)) {
        for (const v of voices) out.push({ kind: "voice", providerId: provider.id, voice: v })
      }
    }
    out.push({ kind: "skip" })
    return out
  })

  // ─── Keyboard navigation ───────────────────────────────────────────────────

  useKeyboard((evt) => {
    if (step() === STEP.ACCOUNT) return // textarea captures Enter

    // Back navigation
    if ((evt.name === "escape" || evt.name === "backspace") && step() > 0) {
      evt.preventDefault()
      setStep((s) => Math.max(0, s - 1))
      return
    }

    // List navigation for extras + image + tts + remote steps
    const current = step()
    if (current === STEP.EXTRAS || current === STEP.IMAGE || current === STEP.TTS || current === STEP.REMOTE) {
      if (evt.name === "up" || evt.name === "k") {
        evt.preventDefault()
        if (current === STEP.EXTRAS) setExtrasCursor((c) => Math.max(0, c - 1))
        else if (current === STEP.IMAGE) setImageCursor((c) => Math.max(0, c - 1))
        else if (current === STEP.TTS) setTtsCursor((c) => Math.max(0, c - 1))
        else if (current === STEP.REMOTE) setRemoteCursor((c) => Math.max(0, c - 1))
        return
      }
      if (evt.name === "down" || evt.name === "j") {
        evt.preventDefault()
        if (current === STEP.EXTRAS) setExtrasCursor((c) => Math.min(EXTRAS.length, c + 1))
        else if (current === STEP.IMAGE) setImageCursor((c) => Math.min(imageOptions().length, c + 1))
        else if (current === STEP.TTS) setTtsCursor((c) => Math.min(ttsRows().length - 1, c + 1))
        else if (current === STEP.REMOTE) setRemoteCursor((c) => Math.min(REMOTE_PROVIDERS.length, c + 1))
        return
      }
      if (evt.name === "space") {
        if (current === STEP.EXTRAS) {
          evt.preventDefault()
          const idx = extrasCursor()
          if (idx >= 0 && idx < EXTRAS.length) {
            const key = EXTRAS[idx]!.key
            batch(() => {
              setExtras(key, (v) => !v)
              // Keep cursor in range; if we just toggled the last flag, keep cursor
              // on it so the user can press space again to disable, then ↓.
            })
          }
        }
        return
      }
    }

    if (evt.name !== "return") return
    evt.preventDefault()
    evt.stopPropagation()
    handleContinue()
  })

  const handleContinue = () => {
    const current = step()
    if (current === STEP.WELCOME) {
      return setStep(STEP.ACCOUNT)
    }
    if (current === STEP.FILESYSTEM) {
      return setStep(STEP.AI_PROVIDER)
    }
    if (current === STEP.AI_PROVIDER) {
      return setStep(STEP.EXTRAS)
    }
    if (current === STEP.EXTRAS) {
      const c = extrasCursor()
      if (c < EXTRAS.length) {
        // Toggling the highlighted feature, then staying on the step.
        const key = EXTRAS[c]!.key
        setExtras(key, (v) => !v)
        return
      }
      // c === EXTRAS.length  →  Continue row
      return advance()
    }
    if (current === STEP.IMAGE) {
      const opts = imageOptions()
      const c = imageCursor()
      if (c < opts.length) {
        const picked = opts[c]!
        void persistImage(picked.providerID, picked.modelID).then((ok) => {
          if (ok) advance()
        })
        return
      }
      // Skip
      return advance()
    }
    if (current === STEP.TTS) {
      const rows = ttsRows()
      const c = ttsCursor()
      const row = rows[c]
      if (!row) return
      if (row.kind === "skip") return advance()
      if (row.kind === "provider") {
        // Selecting a provider row advances the cursor to the first voice of
        // that provider so the next Enter picks one. If user wants to skip
        // they can ↓ all the way to the "skip" row.
        const firstVoiceIdx = rows.findIndex((r) => r.kind === "voice" && r.providerId === row.provider.id)
        if (firstVoiceIdx >= 0) setTtsCursor(firstVoiceIdx)
        return
      }
      // Voice row
      const voice = row.voice
      void (async () => {
        const ok = await persistSpeak(row.providerId, voice.id, voice.name)
        if (!ok) return
        if (row.providerId === "elevenlabs") {
          // After picking an ElevenLabs voice, prompt for the key in a nested
          // dialog. The key is optional (env or file may already provide one).
          dialog.replace(
            () => (
              <DialogPrompt
                title="ElevenLabs API key (optional)"
                placeholder="Paste your ElevenLabs key, or press Esc to skip"
                description={() => (
                  <text>
                    ElevenLabs voices need an API key. If you already set{" "}
                    <span style={{ fg: "primary" }}>ELEVENLABS_API_KEY</span> or wrote one to the secrets file, just
                    press <span style={{ fg: "primary" }}>Esc</span>.
                  </text>
                )}
                onConfirm={async (value) => {
                  const key = value.trim()
                  if (key) {
                    try {
                      await persistElevenLabsKey(key)
                      toast.show({
                        variant: "success",
                        message: "ElevenLabs key saved",
                      })
                    } catch (err) {
                      toast.show({
                        variant: "error",
                        message: `Failed to save key: ${err}`,
                      })
                    }
                  }
                  advance()
                }}
                onCancel={() => advance()}
              />
            ),
            () => advance(),
          )
          return
        }
        advance()
      })()
      return
    }
    if (current === STEP.REMOTE) {
      const c = remoteCursor()
      if (c < REMOTE_PROVIDERS.length) {
        const picked = REMOTE_PROVIDERS[c]!
        void persistRemote(picked.id).then((ok) => {
          if (ok) advance()
        })
        return
      }
      return advance()
    }
    if (current === STEP.TEST) {
      dialog.replace(() => <DialogProviderList />)
      props.onComplete()
      return
    }
  }

  const handleAccountComplete = () => {
    setStep(STEP.FILESYSTEM)
  }

  // Continue hint shown in the footer for static steps. List/text steps
  // override this with a more specific hint.
  const continueHint = createMemo(() => {
    const s = step()
    if (s === STEP.EXTRAS) {
      return extrasCursor() < EXTRAS.length ? "space/↵ toggle · ↵ on Continue" : "↵ continue"
    }
    if (s === STEP.IMAGE) return "↑/↓ move · ↵ select"
    if (s === STEP.TTS) return "↑/↓ move · ↵ pick voice"
    if (s === STEP.REMOTE) return "↑/↓ move · ↵ select"
    if (s === STEP.AI_PROVIDER) return "open provider picker (next step)"
    return STEP_CONTINUE_LABELS[s] ?? ""
  })

  return (
    <box paddingBottom={1}>
      {/* Header */}
      <box
        paddingLeft={2}
        paddingRight={2}
        paddingTop={1}
        paddingBottom={1}
        flexDirection="row"
        justifyContent="space-between"
      >
        <text fg={theme.accent.fg} attributes={TextAttributes.BOLD}>
          {STEP_TITLES[step()]}
        </text>
        <text fg={theme.border.subtle}>nikcli</text>
      </box>

      {/* Step breadcrumb */}
      <box paddingLeft={2} paddingRight={2} paddingBottom={1}>
        <WizardBreadcrumb current={displayIndex() - 1} total={totalSteps()} />
      </box>

      {/* Top separator */}
      <box paddingLeft={2} paddingRight={2}>
        <text fg={theme.border.subtle}>{"─".repeat(Math.min(72, dimensions().width - 4))}</text>
      </box>

      {/* Content */}
      <Switch>
        <Match when={step() !== STEP.ACCOUNT}>
          <scrollbox
            scrollAcceleration={scrollAcceleration()}
            paddingLeft={2}
            paddingRight={2}
            paddingTop={1}
            paddingBottom={1}
            maxHeight={contentMaxHeight()}
            scrollbarOptions={{ visible: false }}
          >
            <Switch>
              <Match when={step() === STEP.WELCOME}>
                <WelcomeContent />
              </Match>
              <Match when={step() === STEP.FILESYSTEM}>
                <FilesystemContent />
              </Match>
              <Match when={step() === STEP.AI_PROVIDER}>
                <ProviderContent />
              </Match>
              <Match when={step() === STEP.EXTRAS}>
                <ExtrasContent
                  enabled={extras}
                  cursor={extrasCursor()}
                  setCursor={setExtrasCursor}
                  toggle={(k) => setExtras(k, (v) => !v)}
                />
              </Match>
              <Match when={step() === STEP.IMAGE}>
                <ImageContent
                  cursor={imageCursor()}
                  setCursor={setImageCursor}
                  onPick={(p, m) => {
                    void persistImage(p, m).then((ok) => ok && advance())
                  }}
                  onSkip={() => advance()}
                />
              </Match>
              <Match when={step() === STEP.TTS}>
                <TTSContent
                  cursor={ttsCursor()}
                  setCursor={setTtsCursor}
                  onPick={(p, v, name) => {
                    void persistSpeak(p, v, name).then((ok) => {
                      if (ok) advance()
                    })
                  }}
                  onSkip={() => advance()}
                  status={ttsStatus()}
                />
              </Match>
              <Match when={step() === STEP.REMOTE}>
                <RemoteContent
                  cursor={remoteCursor()}
                  setCursor={setRemoteCursor}
                  onPick={(id) => {
                    void persistRemote(id).then((ok) => ok && advance())
                  }}
                  onSkip={() => advance()}
                />
              </Match>
              <Match when={step() === STEP.TEST}>
                <TestContent />
              </Match>
            </Switch>
          </scrollbox>
        </Match>
        <Match when={step() === STEP.ACCOUNT}>
          <DialogAccountLogin
            clearOnComplete={false}
            onComplete={(user) => {
              if (user) handleAccountComplete()
            }}
          />
        </Match>
      </Switch>

      {/* Bottom separator */}
      <box paddingLeft={2} paddingRight={2}>
        <text fg={theme.border.subtle}>{"─".repeat(Math.min(72, dimensions().width - 4))}</text>
      </box>

      {/* Footer */}
      <box paddingLeft={2} paddingRight={2} paddingTop={1} flexDirection="row" justifyContent="space-between">
        <Show when={step() !== STEP.ACCOUNT}>
          <text fg={theme.foreground.muted}>
            {"↵ "}
            <span style={{ fg: theme.foreground.default }}>{continueHint()}</span>
          </text>
        </Show>
        <Show when={step() === STEP.ACCOUNT}>
          <text fg={theme.foreground.muted}>Complete sign-in or registration in your browser · esc cancel</text>
        </Show>
        <box flexDirection="row" gap={2} alignItems="center">
          <Show when={step() !== STEP.WELCOME && step() !== STEP.ACCOUNT && step() !== STEP.AI_PROVIDER}>
            <box
              paddingLeft={2}
              paddingRight={2}
              borderColor={theme.border.subtle}
              onMouseUp={() => {
                dialog.replace(() => <DialogProviderList />)
                props.onComplete()
              }}
            >
              <text fg={theme.foreground.muted}>Skip — finish onboarding</text>
            </box>
          </Show>
          <text fg={theme.foreground.muted}>
            <span style={{ fg: theme.border.subtle }}>step </span>
            {displayIndex()}/{totalSteps()}
          </text>
        </box>
      </box>
    </box>
  )
}

// ─── Main export ──────────────────────────────────────────────────────────────

export const DialogOnboarding = {
  run(dialog: DialogContext): Promise<void> {
    return new Promise<void>((resolve) => {
      dialog.replace(
        () => <OnboardingWizard onComplete={resolve} />,
        () => resolve(),
      )
    })
  },
}
