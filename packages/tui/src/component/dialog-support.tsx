import { useScrollAcceleration } from "@tui/util/scroll"
import { TextAttributes, type PasteEvent, type TextareaRenderable } from "@opentui/core"
import { useKeyboard, useTerminalDimensions } from "@opentui/solid"
import { batch, createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js"
import { useTheme } from "@tui/context/theme"
import { useDialog } from "@tui/ui/dialog"
import { useSDK } from "@tui/context/sdk"
import { useLocal } from "@tui/context/local"
import { useSync } from "@tui/context/sync"
import { useSupportSession } from "@tui/context/support-session"
import { useToast } from "@tui/ui/toast"
import { Clipboard } from "@tui/util/clipboard"
import { DialogModel, useConnected } from "@tui/component/dialog-model"
import { buildSupportDocsIndex } from "@tui/util/support-docs"
import { useAbortOnCleanup } from "@tui/util/lifecycle"
import type { Part, TextPart } from "@nikcli-ai/sdk/httpapi"
import {
  buildSupportPromptParts,
  supportPartFromPaste,
  type SupportAttachment,
} from "@tui/component/support-prompt-parts"

/**
 * Cross-platform "open URL in the user's default browser" helper. Falls back
 * to a no-op (the caller's UI shows the URL) when no opener is available.
 */
export async function openExternal(url: string): Promise<void> {
  try {
    const { spawn } = await import("bun")
    const cmd =
      process.platform === "darwin"
        ? ["open", url]
        : process.platform === "win32"
          ? ["cmd", "/c", "start", "", url]
          : ["xdg-open", url]
    const proc = spawn({ cmd, stdout: "ignore", stderr: "ignore" })
    await proc.exited
  } catch {
    // best-effort; the dialog already shows the URL.
  }
}

function Header(props: { title: string; subtitle?: string }) {
  const { theme } = useTheme()
  return (
    <box flexDirection="row" justifyContent="space-between">
      <text attributes={TextAttributes.BOLD} fg={theme.foreground.default}>
        {props.title}
      </text>
      {props.subtitle ? <text fg={theme.foreground.muted}>{props.subtitle}</text> : null}
    </box>
  )
}

function Body(props: { children: string }) {
  const { theme } = useTheme()
  return (
    <text fg={theme.foreground.default} attributes={0}>
      {props.children}
    </text>
  )
}

function Footer(props: { left?: string; right?: string }) {
  const dialog = useDialog()
  const { theme } = useTheme()
  return (
    <box flexDirection="row" justifyContent="space-between" paddingTop={1}>
      <text fg={theme.foreground.muted}>{props.left ?? ""}</text>
      <box paddingLeft={3} paddingRight={3} backgroundColor={theme.accent.fg} onMouseUp={() => dialog.clear()}>
        <text fg={theme.badge.fg}>{props.right ?? "Close"}</text>
      </box>
    </box>
  )
}

function useEscapeCloses() {
  const dialog = useDialog()
  useKeyboard((evt) => {
    if (evt.name === "escape" || evt.name === "return") {
      evt.preventDefault()
      dialog.clear()
    }
  })
}

export function DialogQuickstartInfo() {
  useEscapeCloses()
  return (
    <box paddingLeft={2} paddingRight={2} paddingTop={1} paddingBottom={1} gap={1} flexDirection="column">
      <Header title="Quickstart" subtitle="60-second first-time tour" />
      <Body
        children={
          "Run `nikcli quickstart` in your shell. It walks you through:\n  1. Connecting a provider (or skipping)\n  2. Picking a starter action\n  3. Launching the TUI, a one-shot prompt, or a model browser\n\nThe quickstart re-execs into the chosen command, so you don't have to copy/paste."
        }
      />
      <Footer left="Tip: type /quickstart in the TUI to launch the same flow" />
    </box>
  )
}

export function DialogDoctorInfo() {
  useEscapeCloses()
  return (
    <box paddingLeft={2} paddingRight={2} paddingTop={1} paddingBottom={1} gap={1} flexDirection="column">
      <Header title="Doctor" subtitle="diagnose common setup issues" />
      <Body
        children={
          "Run `nikcli doctor` in your shell. It checks:\n  - Version & runtime\n  - TTY (warns when piped)\n  - PATH (suggests fix if the exec dir is missing)\n  - Disk space (warns when < 5% free)\n  - Config validity (JSON parse)\n  - Deprecated config keys (e.g. `keybinds` → `keymappings`)\n\nUse --json for a structured report."
        }
      />
      <Footer left="Tip: type /doctor in the TUI to launch the same flow" />
    </box>
  )
}

// =============================================================================
// DialogSupport — chat with the read-only documentation assistant.
// =============================================================================

type ChatMessage = {
  /** Stable id; for streaming assistant messages this is the messageID. */
  id: string
  role: "user" | "assistant"
  text: string
  time: number
  /** True while the assistant is still streaming this message. */
  pending?: boolean
  /** Set if sending or streaming failed for this message. */
  error?: string
}

/** Quickstart hints shown when no provider is connected yet — getting set
 * up matters more than feature questions at that point. */
const SETUP_HINTS: ReadonlyArray<{ title: string; prompt: string }> = [
  { title: "Connect a provider", prompt: "How do I connect a model provider?" },
  {
    title: "Use an API key",
    prompt: "How do I configure an API key for Anthropic or OpenAI?",
  },
  { title: "Free models", prompt: "Are there free models I can start with?" },
  {
    title: "First session",
    prompt: "How do I start my first session once a provider is connected?",
  },
]

const WELCOME_HINTS: ReadonlyArray<{ title: string; prompt: string }> = [
  { title: "Change model", prompt: "How do I change the default model?" },
  {
    title: "Agent vs session",
    prompt: "What is an agent in nikcli and how do I choose one?",
  },
  {
    title: "Useful keybinds",
    prompt: "What are the main keyboard shortcuts?",
  },
  {
    title: "Slash commands",
    prompt: "What slash commands exist and what do they do?",
  },
  { title: "MCP server", prompt: "How do I add an MCP server?" },
  { title: "Skills", prompt: "What are skills and how do I use them?" },
]

function timeLabel(ts: number): string {
  const d = new Date(ts)
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
}

export function DialogSupport() {
  const dialog = useDialog()
  const scrollAcceleration = useScrollAcceleration()
  const { theme } = useTheme()
  const sdk = useSDK()
  const local = useLocal()
  const sync = useSync()
  const toast = useToast()
  const support = useSupportSession()
  const dimensions = useTerminalDimensions()

  // Resolved dialog state ----------------------------------------------------

  const [messages, setMessages] = createSignal<ChatMessage[]>([])
  const [busy, setBusy] = createSignal(false)
  const [initError, setInitError] = createSignal<string | null>(null)
  const [ready, setReady] = createSignal(false)
  /** True while we still expect a "session.idle" event after the last send. */
  const [streaming, setStreaming] = createSignal(false)
  /** The current assistant messageID we are appending to (null if not streaming). */
  const [streamingID, setStreamingID] = createSignal<string | null>(null)
  const [attachments, setAttachments] = createSignal<SupportAttachment[]>([])

  let textarea: TextareaRenderable | undefined
  const life = useAbortOnCleanup()
  // Filled after the awaits in `onMount`, where there is no owner left: an
  // `onCleanup` registered there never runs, and `sdk.event.on` cannot attach
  // its own unsubscribe either. So the release is registered here, while the
  // owner is still current, and the subscriptions are added to it later.
  const subscriptions: Array<() => void> = []
  onCleanup(() => {
    for (const off of subscriptions.splice(0)) off()
  })

  const msgHeight = createMemo(() => Math.max(8, Math.min(20, dimensions().height - 16)))

  // Helpers ------------------------------------------------------------------

  function appendOrUpdateMessage(next: ChatMessage) {
    setMessages((prev) => {
      const idx = prev.findIndex((m) => m.id === next.id)
      if (idx === -1) return [...prev, next]
      const copy = prev.slice()
      copy[idx] = { ...copy[idx], ...next }
      return copy
    })
  }

  function appendTextToMessage(id: string, text: string) {
    if (!text) return
    setMessages((prev) => {
      const idx = prev.findIndex((m) => m.id === id)
      if (idx === -1) {
        return [...prev, { id, role: "assistant", text, time: Date.now(), pending: true }]
      }
      const copy = prev.slice()
      copy[idx] = { ...copy[idx], text: copy[idx].text + text }
      return copy
    })
  }

  function finalizeMessage(id: string) {
    setMessages((prev) => {
      const idx = prev.findIndex((m) => m.id === id)
      if (idx === -1) return prev
      const copy = prev.slice()
      copy[idx] = { ...copy[idx], pending: false }
      return copy
    })
  }

  // Lifecycle ----------------------------------------------------------------

  onMount(async () => {
    dialog.setSize("xlarge")

    try {
      const sessionID = await support.ensure()
      if (life.disposed()) return
      // Load history (latest 100 messages)
      const history = await sdk.client.session.messages({ sessionID }, { signal: life.signal }).catch(() => null)
      if (life.disposed()) return
      const list = history?.data ?? []
      const initial: ChatMessage[] = []
      for (const entry of list) {
        const text = (entry.parts ?? [])
          .filter((p): p is TextPart => p?.type === "text")
          .map((p) => p.text ?? "")
          .join("")
        if (!text && entry.info.role === "assistant") continue
        initial.push({
          id: entry.info.id,
          role: entry.info.role,
          text,
          time: entry.info.time?.created ?? Date.now(),
        })
      }
      setMessages(initial)
      setReady(true)

      // Subscribe to live events for this session.
      const offPart = sdk.event.on("message.part.updated" as never, (evt: any) => {
        if (!evt?.properties?.part) return
        const part: Part = evt.properties.part
        if (part.sessionID !== sessionID) return
        if (part.type !== "text") return
        const id = part.messageID
        if (!id) return
        if (id !== streamingID() && !messages().some((m) => m.id === id)) {
          // New assistant message we didn't see the start of: create it.
          setStreamingID(id)
          setStreaming(true)
        }
        // Prefer the accumulated `text` field if present (server may send the
        // full state); otherwise append the delta.
        const full = (part as TextPart).text
        const delta: string | undefined = evt.properties.delta
        if (typeof full === "string" && full.length > 0) {
          setMessages((prev) => {
            const idx = prev.findIndex((m) => m.id === id)
            if (idx === -1) {
              return [
                ...prev,
                {
                  id,
                  role: "assistant",
                  text: full,
                  time: Date.now(),
                  pending: true,
                },
              ]
            }
            const copy = prev.slice()
            copy[idx] = { ...copy[idx], text: full }
            return copy
          })
        } else if (delta) {
          appendTextToMessage(id, delta)
        }
      })

      const offIdle = sdk.event.on("session.idle" as never, (evt: any) => {
        if (evt?.properties?.sessionID !== sessionID) return
        const id = streamingID()
        if (id) finalizeMessage(id)
        batch(() => {
          setStreamingID(null)
          setStreaming(false)
          setBusy(false)
        })
        // Refocus the textarea for the next turn.
        setTimeout(() => textarea?.focus(), 30)
      })

      const offError = sdk.event.on("session.error" as never, (evt: any) => {
        if (evt?.properties?.sessionID !== sessionID) return
        const message = evt?.properties?.error?.data?.message ?? "Unknown error from support agent"
        const id = streamingID()
        if (id) {
          setMessages((prev) => {
            const idx = prev.findIndex((m) => m.id === id)
            if (idx === -1) return prev
            const copy = prev.slice()
            copy[idx] = { ...copy[idx], pending: false, error: message }
            return copy
          })
        } else {
          setInitError(message)
        }
        batch(() => {
          setStreamingID(null)
          setStreaming(false)
          setBusy(false)
        })
        toast.show({ message, variant: "error", duration: 6000 })
      })

      subscriptions.push(offPart, offIdle, offError)
    } catch (err) {
      if (life.disposed()) return
      const msg = err instanceof Error ? err.message : String(err)
      setInitError(msg)
      setReady(true)
    }
  })

  // Focus the textarea on mount once ready
  createEffect(() => {
    if (ready() && textarea && !textarea.isDestroyed && !textarea.focused) {
      setTimeout(() => textarea?.focus(), 30)
    }
  })

  // Send ---------------------------------------------------------------------

  async function send(text: string, fileAttachments?: SupportAttachment[]) {
    const pending = fileAttachments ?? attachments()
    const trimmed = text.trim()
    if ((!trimmed && pending.length === 0) || busy()) return
    const sessionID = support.id
    if (!sessionID) {
      setInitError("Support session not ready — try again in a moment.")
      return
    }
    const model = support.model ?? local.model.current()
    if (!model) {
      toast.show({
        message: "No provider connected. Connect one in /providers first.",
        variant: "warning",
        duration: 5000,
      })
      return
    }

    // Build system prompt (lazy: the docs index is cached in-process).
    const cwd = sdk.directory ?? process.cwd()
    const docsIndex = await buildSupportDocsIndex(cwd).catch(() => "")

    // Optimistic user message
    const localId = `local-${Date.now()}`
    const displayText =
      trimmed + (pending.length > 0 ? (trimmed ? "\n" : "") + pending.map((a) => a.label).join(" ") : "")
    appendOrUpdateMessage({
      id: localId,
      role: "user",
      text: displayText,
      time: Date.now(),
    })
    batch(() => {
      setBusy(true)
      setInitError(null)
    })

    try {
      await sdk.client.session
        .prompt({
          sessionID,
          agent: "support",
          model,
          system: docsIndex || undefined,
          parts: buildSupportPromptParts(trimmed, pending),
        })
        .catch((err) => {
          throw err
        })
      // The actual assistant text arrives via SSE "message.part.updated" events.
      // We don't await here because the call returns once the user message is
      // accepted; the assistant streams asynchronously.
      setAttachments([])
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      setMessages((prev) => {
        const idx = prev.findIndex((m) => m.id === localId)
        if (idx === -1) return prev
        const copy = prev.slice()
        copy[idx] = { ...copy[idx], error: msg }
        return copy
      })
      toast.show({
        message: `Failed to send: ${msg}`,
        variant: "error",
        duration: 5000,
      })
      setBusy(false)
    }
  }

  async function resetConversation() {
    if (busy()) return
    await support.reset()
    setMessages([])
    setAttachments([])
    setInitError(null)
    toast.show({
      message: "Support conversation reset.",
      variant: "info",
      duration: 2000,
    })
  }

  // Keyboard -----------------------------------------------------------------

  useKeyboard((evt) => {
    if (evt.name === "escape") {
      evt.preventDefault()
      dialog.clear()
      return
    }
    // Ctrl+L — clear conversation
    if (evt.ctrl && evt.name === "l") {
      resetConversation().catch(() => {})
      evt.preventDefault()
      return
    }
    // Ctrl+O — pick the model used for support replies (persisted)
    if (evt.ctrl && evt.name === "o") {
      evt.preventDefault()
      dialog.replace(() => (
        <DialogModel
          onSelect={(model) => {
            support.setModel(model).catch(() => {})
            // DialogModel clears the stack right after onSelect — reopen on
            // the next tick so the support conversation comes back up
            setTimeout(() => dialog.replace(() => <DialogSupport />), 0)
          }}
        />
      ))
      return
    }
    // Ctrl+Y — copy the last assistant reply (hover is not a thing in a TUI)
    if (evt.ctrl && evt.name === "y") {
      evt.preventDefault()
      const last = messages().findLast((m) => m.role === "assistant" && m.text)
      if (!last) return
      Clipboard.copy(last.text)
        .then(() =>
          toast.show({
            message: "Reply copied to clipboard.",
            variant: "info",
            duration: 2000,
          }),
        )
        .catch(() =>
          toast.show({
            message: "Could not copy to clipboard.",
            variant: "warning",
            duration: 3000,
          }),
        )
      return
    }
  })

  // Render -------------------------------------------------------------------

  const agentName = createMemo(() => {
    const a = sync.data.agent.find((x) => x.name === "support")
    return a?.name ?? "support"
  })
  const modelName = createMemo(() => {
    const override = support.model
    if (override) return `${override.providerID} / ${override.modelID}`
    const m = local.model.parsed()
    return `${m.provider} / ${m.model}`
  })

  return (
    <box gap={1} paddingBottom={1}>
      {/* Header */}
      <box paddingLeft={2} paddingRight={2}>
        <box flexDirection="row" justifyContent="space-between">
          <box flexDirection="row" gap={1}>
            <text attributes={TextAttributes.BOLD} fg={theme.foreground.default}>
              Support
            </text>
            <text fg={theme.foreground.muted}>@{agentName()}</text>
            <text fg={theme.foreground.muted}>·</text>
            <text fg={theme.foreground.muted}>{modelName()}</text>
          </box>
          <text fg={theme.foreground.muted}>{streaming() ? "● responding" : busy() ? "● sending" : "esc close"}</text>
        </box>
      </box>

      {/* Messages */}
      {/* `stickyScroll` replaces the two effects that used to re-pin the view on
          every token: those scrolled to the bottom unconditionally, so reading
          back through the transcript while the assistant was still streaming
          yanked the view away every few milliseconds. OpenTUI's sticky scroll
          follows the tail only while the view *is* at the tail, and re-engages
          by itself once the reader scrolls back down to it. */}
      <scrollbox
        scrollAcceleration={scrollAcceleration()}
        maxHeight={msgHeight()}
        scrollbarOptions={{ visible: false }}
        stickyScroll={true}
        stickyStart="bottom"
        viewportCulling={true}
        paddingLeft={2}
        paddingRight={2}
      >
        <Show when={!ready()}>
          <text fg={theme.foreground.muted}>Loading support session…</text>
        </Show>
        <Show when={ready() && messages().length === 0}>
          <WelcomeHints onPick={(p) => send(p)} />
        </Show>
        <Show when={initError()}>
          <box paddingBottom={1}>
            <text fg={theme.status.error.fg}>{initError()}</text>
          </box>
        </Show>
        <For each={messages()}>{(m) => <MessageRow msg={m} />}</For>
        <Show when={streaming() && messages().at(-1)?.role !== "assistant"}>
          <box flexDirection="row" gap={1}>
            <text fg={theme.accent.alt} attributes={TextAttributes.BOLD}>
              support
            </text>
            <text fg={theme.foreground.muted}>is typing…</text>
          </box>
        </Show>
      </scrollbox>

      {/* Input */}
      <box paddingLeft={2} paddingRight={2} gap={1} paddingTop={1}>
        <Show when={attachments().length > 0}>
          <For each={attachments()}>{(item) => <text fg={theme.accent.fg}>{item.label}</text>}</For>
        </Show>
        <textarea
          height={3}
          keyBindings={[{ name: "return", action: "submit" }]}
          onSubmit={() => {
            const value = textarea?.plainText ?? ""
            if ((value.trim() || attachments().length > 0) && !busy()) {
              send(value)
              textarea?.clear()
            }
          }}
          onPaste={async (event: PasteEvent) => {
            if (busy()) {
              event.preventDefault()
              return
            }
            const text = new TextDecoder().decode(event.bytes)
            const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim()
            if (!normalized) return
            const attached = await supportPartFromPaste(normalized)
            if (!attached) return
            event.preventDefault()
            setAttachments((prev) => [...prev, attached])
          }}
          ref={(r: TextareaRenderable) => {
            textarea = r
          }}
          placeholder={busy() ? "Support is responding — please wait..." : "Ask Support… paste a file path to attach"}
          textColor={theme.foreground.default}
          focusedTextColor={theme.foreground.default}
          cursorColor={theme.foreground.default}
        />
        <text fg={theme.foreground.muted}>
          <span style={{ fg: theme.accent.fg }}>enter</span> send · paste file path to attach ·{" "}
          <span style={{ fg: theme.accent.fg }}>ctrl+o</span> model ·{" "}
          <span style={{ fg: theme.accent.fg }}>ctrl+y</span> copy reply ·{" "}
          <span style={{ fg: theme.accent.fg }}>ctrl+l</span> new conversation ·{" "}
          <span style={{ fg: theme.accent.fg }}>esc</span> close
        </text>
      </box>
    </box>
  )
}

// =============================================================================
// Subcomponents
// =============================================================================

function MessageRow(props: { msg: ChatMessage }) {
  const { theme, syntax } = useTheme()
  const m = props.msg
  return (
    <box paddingBottom={1} flexDirection="column" gap={0}>
      <box flexDirection="row" gap={1}>
        <text fg={m.role === "user" ? theme.accent.fg : theme.accent.alt} attributes={TextAttributes.BOLD}>
          {m.role === "user" ? "you" : "support"}
        </text>
        <text fg={theme.foreground.muted}>{timeLabel(m.time)}</text>
        <Show when={m.pending}>
          <text fg={theme.foreground.muted}>…</text>
        </Show>
        <Show when={m.error}>
          <text fg={theme.status.error.fg}>! {m.error}</text>
        </Show>
      </box>
      <Show
        when={m.role === "assistant" && m.text}
        fallback={
          <text fg={theme.foreground.default} wrapMode="word">
            {m.text || (m.pending ? " " : "")}
          </text>
        }
      >
        <markdown
          streaming={m.pending === true}
          syntaxStyle={syntax()}
          content={m.text}
          fg={theme.foreground.default}
          tableOptions={{
            widthMode: "full",
            wrapMode: "word",
            cellPadding: 0,
            borders: true,
            outerBorder: false,
            borderColor: theme.border.subtle,
          }}
        />
      </Show>
    </box>
  )
}

function WelcomeHints(props: { onPick: (prompt: string) => void }) {
  const { theme } = useTheme()
  const connected = useConnected()
  return (
    <box gap={1} flexDirection="column" paddingBottom={1}>
      <text fg={theme.foreground.default}>
        Hi! I'm <span style={{ fg: theme.accent.alt }}>Support</span>, nikcli's documentation assistant.
      </text>
      <Show
        when={connected()}
        fallback={
          <text fg={theme.foreground.muted}>
            No model provider is connected yet — let me help you get set up. Open{" "}
            <span style={{ fg: theme.accent.fg }}>/providers</span> to connect one, or ask me how:
          </text>
        }
      >
        <text fg={theme.foreground.muted}>
          I can answer questions about commands, configuration, agents, MCP, keybinds, workflows, and troubleshooting.
        </text>
      </Show>
      <text fg={theme.foreground.muted} attributes={TextAttributes.BOLD}>
        Examples:
      </text>
      <For each={connected() ? WELCOME_HINTS : SETUP_HINTS}>
        {(hint) => (
          <box
            flexDirection="row"
            paddingLeft={1}
            paddingRight={1}
            onMouseUp={() => props.onPick(hint.prompt)}
            backgroundColor={theme.surface.panel}
          >
            <text fg={theme.foreground.default}>
              <span style={{ fg: theme.accent.alt }}>›</span> {hint.title}
              <span style={{ fg: theme.foreground.muted }}> — {hint.prompt}</span>
            </text>
          </box>
        )}
      </For>
    </box>
  )
}

// (end of file)
