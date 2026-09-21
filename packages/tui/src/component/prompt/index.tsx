import { BoxRenderable, TextareaRenderable, MouseEvent, PasteEvent } from "@opentui/core"
import {
  createEffect,
  createMemo,
  type JSX,
  onMount,
  createSignal,
  onCleanup,
  on,
  Show,
  Switch,
  Match,
  For,
} from "solid-js"
import { registerSpinner } from "opentui-spinner/solid"
import { TuiPluginRuntime } from "@tui/plugin"
import { useLocal } from "@tui/context/local"
import { useLanguage } from "@tui/context/language"
import { useTheme } from "@tui/context/theme"
import { hasSessionStyle, readSessionStyle, resolveSessionStyle } from "@tui/feature-plugins/session-studio/settings"
import { EmptyBorder, SplitBorder } from "@tui/component/border"
import { useSDK } from "@tui/context/sdk"
import { useRoute } from "@tui/context/route"
import { useSync } from "@tui/context/sync"
import { Identifier } from "@nikcli-ai/util/id"
import { createStore, produce } from "solid-js/store"
import { useKeybind } from "@tui/context/keybind"
import { usePromptHistory, type PromptInfo } from "./history"
import { usePromptStash } from "./stash"
import { DialogStash } from "../dialog-stash"
import { type AutocompleteRef, Autocomplete } from "./autocomplete"
import { useCommandDialog } from "../dialog-command"
import { useRenderer, useTerminalDimensions } from "@opentui/solid"
import { Editor } from "@tui/util/editor"
import { useExit } from "../../context/exit"
import { useEditorContext } from "../../context/editor"
import { Clipboard } from "../../util/clipboard"
import type { AssistantMessage, FilePart } from "@nikcli-ai/sdk/httpapi"
import { TuiEventName } from "@nikcli-ai/util/tui-event-schema"
import { iife } from "@nikcli-ai/util/iife"
import { userFacingParts } from "@nikcli-ai/util/user-error"
import { Locale } from "@nikcli-ai/util/locale"
import { formatDuration } from "@nikcli-ai/util/format"
import { createColors, createFrames } from "../../ui/spinner.ts"
import type { SpinnerStyle } from "../dialog-settings/spinner"
import { useDialog } from "@tui/ui/dialog"
import { DialogProvider as DialogProviderConnect } from "../dialog-provider"
import { DialogAlert } from "../../ui/dialog-alert"
import { useToast } from "../../ui/toast"
import { useKV } from "../../context/kv"
import { useTextareaKeybindings } from "../textarea-keybindings"
import { DialogThemeCreate } from "../dialog-theme-create"
import { currentAgentPermissionMode, permissionModeColor, permissionModeShortLabel } from "../dialog-permission-mode"
import { DialogImageModel } from "../dialog-image-model"
import { DialogSpeakModel } from "../dialog-speak-model"
import { DialogRemote } from "../dialog-remote"
import { DialogMobileConnect } from "../dialog-mobile-connect"
import { DialogWebPreview } from "../dialog-web-preview"
import os from "os"
import path from "path"
import { friendlyErrorMessage } from "../../util/error-message"
import { PromptJobsInlineCompact } from "../prompt-jobs-inline"
import { getMonitorsSorted, type MonitorInfo } from "../../util/monitor-helpers"

registerSpinner()

export type PromptProps = {
  sessionID?: string
  workspaceID?: string
  visible?: boolean
  disabled?: boolean
  onSubmit?: () => void
  ref?: (ref: PromptRef) => void
  hint?: JSX.Element
  showPlaceholder?: boolean
}

export type PromptRef = {
  focused: boolean
  current: PromptInfo
  set(prompt: PromptInfo): void
  reset(): void
  blur(): void
  focus(): void
  submit(): void
}

// i18n keys for the rotating placeholder examples (see specs/opencode-parity/06-tui-i18n.md).
const PLACEHOLDER_KEYS = ["prompt.example.todo", "prompt.example.techStack", "prompt.example.tests"] as const
const SHELL_PLACEHOLDER_KEYS = [
  "prompt.shellExample.ls",
  "prompt.shellExample.gitStatus",
  "prompt.shellExample.pwd",
] as const
const money = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
})
const SWIFT_MIC_PERMISSION_ERROR = "__NIKCLI_MIC_PERMISSION_DENIED__"

const SWIFT_RECORDER_SOURCE = String.raw`
import Foundation
import AVFoundation

let permissionMarker = "__NIKCLI_MIC_PERMISSION_DENIED__"

guard CommandLine.arguments.count >= 2 else {
  fputs("missing output path\n", stderr)
  exit(2)
}

let outputPath = CommandLine.arguments[1]
let outputURL = URL(fileURLWithPath: outputPath)

let semaphore = DispatchSemaphore(value: 0)
var granted = false

AVCaptureDevice.requestAccess(for: .audio) { allowed in
  granted = allowed
  semaphore.signal()
}

_ = semaphore.wait(timeout: .now() + 30)

if !granted {
  fputs(permissionMarker + "\n", stderr)
  exit(13)
}

let settings: [String: Any] = [
  AVFormatIDKey: Int(kAudioFormatLinearPCM),
  AVSampleRateKey: 16000,
  AVNumberOfChannelsKey: 1,
  AVLinearPCMBitDepthKey: 16,
  AVLinearPCMIsBigEndianKey: false,
  AVLinearPCMIsFloatKey: false,
]

do {
  let recorder = try AVAudioRecorder(url: outputURL, settings: settings)
  recorder.prepareToRecord()

  if !recorder.record() {
    fputs("failed to start recording\n", stderr)
    exit(14)
  }

  signal(SIGINT, SIG_IGN)
  signal(SIGTERM, SIG_IGN)

  let stop: () -> Void = {
    recorder.stop()
    exit(0)
  }

  let sigintSource = DispatchSource.makeSignalSource(signal: SIGINT, queue: .main)
  sigintSource.setEventHandler(handler: stop)
  sigintSource.resume()

  let sigtermSource = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
  sigtermSource.setEventHandler(handler: stop)
  sigtermSource.resume()

  RunLoop.main.run()
} catch {
  fputs("recorder error: \(error)\n", stderr)
  exit(15)
}
`

export function sessionRequestContext(input: {
  routeWorkspaceID?: string
  sessionWorkspaceID?: string
  fallbackWorkspaceID?: string
  sessionDirectory?: string
  fallbackDirectory: string
}) {
  return {
    workspace: input.routeWorkspaceID ?? input.sessionWorkspaceID ?? input.fallbackWorkspaceID,
    directory: input.sessionDirectory ?? input.fallbackDirectory,
  }
}

export function Prompt(props: PromptProps) {
  let input: TextareaRenderable
  let anchor: BoxRenderable
  let autocomplete: AutocompleteRef
  let interruptResetTimer: ReturnType<typeof setTimeout> | undefined

  function liveComposer() {
    if (!input || input.isDestroyed) return undefined
    return input
  }

  function clearComposer() {
    const current = liveComposer()
    if (!current) return
    try {
      current.extmarks.clear()
    } catch {
      // EditBuffer already gone (route change, CSI overlay, unmount).
    }
    try {
      current.clear()
    } catch {}
  }

  const keybind = useKeybind()
  const local = useLocal()
  const sdk = useSDK()
  const route = useRoute()
  const sync = useSync()
  const dialog = useDialog()
  const toast = useToast()
  const status = createMemo(() => sync.data.session_status?.[props.sessionID ?? ""] ?? { type: "idle" })
  const permissionMode = createMemo(() =>
    currentAgentPermissionMode(sync.data.config as Record<string, any>, local.agent.current().name),
  )
  const history = usePromptHistory()
  const stash = usePromptStash()
  const command = useCommandDialog()
  const renderer = useRenderer()
  const dimensions = useTerminalDimensions()
  const { theme, syntax } = useTheme()
  const kv = useKV()
  const sessionStyle = createMemo(() =>
    hasSessionStyle(kv, props.sessionID)
      ? resolveSessionStyle(theme, readSessionStyle(kv, props.sessionID))
      : undefined,
  )
  const promptBackground = createMemo(() => sessionStyle()?.prompt.backgroundColor ?? theme.surface.offset)
  const lang = useLanguage()
  const editor = useEditorContext()
  const activeSession = createMemo(() => (props.sessionID ? sync.session.get(props.sessionID) : undefined))
  const activeContext = createMemo(() => {
    const current = route.data
    return sessionRequestContext({
      routeWorkspaceID:
        current.type === "session" && current.sessionID === props.sessionID ? current.workspaceID : undefined,
      sessionWorkspaceID: activeSession()?.workspaceID,
      fallbackWorkspaceID: props.workspaceID,
      sessionDirectory: activeSession()?.directory,
      fallbackDirectory: sync.data.path.directory,
    })
  })
  const editorContextVisible = createMemo(() => kv.get("editor_context_visibility", true) as boolean)
  const editorPath = createMemo(() => editor.selection()?.filePath)
  const editorSelectionLabel = createMemo(() => {
    const selection = editor.selection()?.selection
    if (!selection) return
    if (selection.start.line === selection.end.line && selection.start.character === selection.end.character) return
    if (selection.start.line === selection.end.line) return `#${selection.start.line}`
    return `#${selection.start.line}-${selection.end.line}`
  })
  const editorFileLabel = createMemo(() => {
    const value = editorPath()
    if (!value) return
    const filename = path.basename(value)
    const file = /^index\.[^./]+$/.test(filename)
      ? [path.basename(path.dirname(value)), filename].filter(Boolean).join("/")
      : filename
    return `${file.split(path.sep).join("/")}${editorSelectionLabel() ?? ""}`
  })
  const editorFileLabelDisplay = createMemo(() => {
    const file = editorFileLabel()
    if (!file) return
    return Locale.truncateMiddle(file, Math.max(12, Math.min(48, Math.floor(dimensions().width / 3))))
  })
  const ads = createMemo(() => sync.data.config.ads)
  const [currentAd, setCurrentAd] = createSignal<string | null>(null)
  const [voiceStatus, setVoiceStatus] = createSignal<"idle" | "recording" | "transcribing">("idle")

  let voiceRecorder: ReturnType<typeof Bun.spawn> | null = null
  let voiceAudioPath: string | null = null
  let voiceAutoStopTimer: ReturnType<typeof setTimeout> | undefined
  let voicePressStartedAt = 0
  let swiftRecorderScriptPath: string | null = null
  let hasShownMicHint = false

  function cleanupVoiceAudio(filePath: string | null) {
    if (!filePath) return
    void Bun.file(filePath)
      .delete()
      .catch(() => {})
  }

  async function ensureSwiftRecorderScriptPath(): Promise<string | null> {
    if (process.platform !== "darwin") return null
    if (swiftRecorderScriptPath) return swiftRecorderScriptPath

    const swift = Bun.which("swift")
    if (!swift) return null

    const scriptPath = path.join(os.tmpdir(), "nikcli-mic-recorder.swift")
    const file = Bun.file(scriptPath)
    const exists = await file.exists()

    if (!exists) {
      await Bun.write(scriptPath, SWIFT_RECORDER_SOURCE)
    } else {
      const current = await file.text().catch(() => "")
      if (current !== SWIFT_RECORDER_SOURCE) {
        await Bun.write(scriptPath, SWIFT_RECORDER_SOURCE)
      }
    }

    swiftRecorderScriptPath = scriptPath
    return swiftRecorderScriptPath
  }

  async function detectVoiceRecorder(filePath: string): Promise<{ command: string[]; name: string } | null> {
    const ffmpeg = Bun.which("ffmpeg")
    if (ffmpeg) {
      if (process.platform === "darwin") {
        return {
          name: "ffmpeg",
          command: [
            ffmpeg,
            "-hide_banner",
            "-loglevel",
            "error",
            "-f",
            "avfoundation",
            "-i",
            "none:0",
            "-ac",
            "1",
            "-ar",
            "16000",
            "-c:a",
            "pcm_s16le",
            "-y",
            filePath,
          ],
        }
      }

      if (process.platform === "linux") {
        return {
          name: "ffmpeg",
          command: [
            ffmpeg,
            "-hide_banner",
            "-loglevel",
            "error",
            "-f",
            "pulse",
            "-i",
            "default",
            "-ac",
            "1",
            "-ar",
            "16000",
            "-c:a",
            "pcm_s16le",
            "-y",
            filePath,
          ],
        }
      }

      if (process.platform === "win32") {
        return {
          name: "ffmpeg",
          command: [
            ffmpeg,
            "-hide_banner",
            "-loglevel",
            "error",
            "-f",
            "dshow",
            "-i",
            "audio=default",
            "-ac",
            "1",
            "-ar",
            "16000",
            "-c:a",
            "pcm_s16le",
            "-y",
            filePath,
          ],
        }
      }
    }

    const rec = Bun.which("rec")
    if (rec) {
      return {
        name: "rec",
        command: [rec, "-q", "-c", "1", "-r", "16000", filePath],
      }
    }

    if (process.platform === "darwin") {
      const swift = Bun.which("swift")
      const scriptPath = await ensureSwiftRecorderScriptPath()
      if (swift && scriptPath) {
        return {
          name: "swift-avfoundation",
          command: [swift, scriptPath, filePath],
        }
      }
    }

    return null
  }

  function looksLikeMicPermissionError(message: string): boolean {
    const value = message.toLowerCase()
    return (
      value.includes(SWIFT_MIC_PERMISSION_ERROR.toLowerCase()) ||
      value.includes("permission denied") ||
      value.includes("not permitted") ||
      value.includes("not authorized") ||
      value.includes("operation not permitted")
    )
  }

  function currentTerminalName(): string {
    return process.env.TERM_PROGRAM || process.env.TERMINAL_EMULATOR || process.env.TERM || "terminal"
  }

  function isLikelyIntegratedTerminal(): boolean {
    const value = currentTerminalName().toLowerCase()
    return value.includes("vscode") || value.includes("zed") || value.includes("warp") || value.includes("jetbrains")
  }

  function extractTranscriptContent(content: unknown): string {
    if (typeof content === "string") return content.trim()
    if (!Array.isArray(content)) return ""

    const merged = content
      .map((part) => {
        if (typeof part === "string") return part
        if (part && typeof part === "object" && "text" in part && typeof (part as any).text === "string") {
          return (part as any).text
        }
        return ""
      })
      .join(" ")
      .trim()

    return merged
  }

  /**
   * Recording is a device concern; the credential is not.
   *
   * This used to resolve the OpenRouter key from `auth.json` and `nikcli.json`
   * and post the WAV itself — about 200 lines, two endpoint shapes and a 402
   * special case, all of it needing `Auth` in the terminal. The server holds
   * the key, so it makes the call: the composer sends bytes and gets a string.
   *
   * The route reports failure in the body, so an empty transcript with an
   * `error` is the shape to check, not a rejected promise.
   */
  async function transcribeVoiceAudio(filePath: string): Promise<string> {
    const audio = await Bun.file(filePath).arrayBuffer()
    if (audio.byteLength === 0) {
      throw new Error("Recorded audio is empty")
    }

    const result = await sdk.client.voice.transcribe({
      audio: Buffer.from(audio).toString("base64"),
      format: "wav",
    })
    const error = result.data?.error
    if (error) throw new Error(error)
    const transcript = result.data?.transcript
    if (!transcript) throw new Error("No transcript returned")
    return transcript
  }

  let isStartingRecording = false
  /**
   * Set when a stop arrives while `startVoiceRecording` is still detecting.
   *
   * `detectVoiceRecorder` probes the filesystem for ffmpeg/sox, which is long
   * enough to release a hold-to-talk key inside. `stopVoiceRecording` sees no
   * recorder yet and returns, and the spawn then happens anyway — a microphone
   * process nobody started and nobody is going to stop.
   *
   * A plain flag, deliberately: this is not a disposed owner, it is a press
   * that ended, and the component is still very much mounted.
   */
  let voiceStartCancelled = false
  async function startVoiceRecording() {
    if (voiceStatus() !== "idle") return
    if (isStartingRecording) return
    isStartingRecording = true
    voiceStartCancelled = false

    try {
      const filePath = path.join(os.tmpdir(), `nikcli-voice-${Date.now()}-${Math.random().toString(16).slice(2)}.wav`)
      const recorder = await detectVoiceRecorder(filePath)
      if (voiceStartCancelled) return

      if (!recorder) {
        const msg =
          process.platform === "darwin"
            ? "Voice mode requires ffmpeg, sox, or macOS Command Line Tools (swift)"
            : process.platform === "win32"
              ? "Voice mode requires ffmpeg with dshow support (try: choco install ffmpeg)"
              : "Voice mode requires ffmpeg or sox (rec) installed"
        toast.show({ variant: "error", message: msg, duration: 4000 })
        return
      }

      if (!hasShownMicHint) {
        hasShownMicHint = true
        const message =
          process.platform === "darwin"
            ? "If prompted, allow microphone access for your terminal"
            : process.platform === "win32"
              ? "If recording fails, check microphone privacy settings (Settings > Privacy > Microphone)"
              : "Allow microphone access when prompted by your operating system"
        toast.show({ variant: "info", message, duration: 3500 })
      }

      try {
        voiceAudioPath = filePath
        voiceRecorder = Bun.spawn(recorder.command, {
          windowsHide: true,
          stdout: "ignore",
          stderr: "pipe",
        })
        voiceAutoStopTimer = setTimeout(() => {
          void stopVoiceRecording()
        }, 90_000)
        setVoiceStatus("recording")
        toast.show({
          variant: "info",
          message: `Recording started (${recorder.name}). Hold to talk, or click again to stop`,
          duration: 2500,
        })
      } catch {
        cleanupVoiceAudio(filePath)
        voiceAudioPath = null
        voiceRecorder = null
        if (voiceAutoStopTimer) {
          clearTimeout(voiceAutoStopTimer)
          voiceAutoStopTimer = undefined
        }
        setVoiceStatus("idle")
        toast.show({
          variant: "error",
          message: "Failed to start voice recording",
          duration: 3000,
        })
      }
    } finally {
      isStartingRecording = false
    }
  }

  async function stopVoiceRecording() {
    if (!voiceRecorder || !voiceAudioPath) {
      // Nothing to stop *yet* — a start may still be detecting. Say so, so it
      // does not spawn into a press that is already over.
      voiceStartCancelled = true
      setVoiceStatus("idle")
      return
    }

    const recorder = voiceRecorder
    const filePath = voiceAudioPath
    voiceRecorder = null
    voiceAudioPath = null
    if (voiceAutoStopTimer) {
      clearTimeout(voiceAutoStopTimer)
      voiceAutoStopTimer = undefined
    }
    setVoiceStatus("transcribing")

    try {
      try {
        recorder.kill("SIGINT")
      } catch {
        recorder.kill()
      }

      await Promise.race([recorder.exited, new Promise((resolve) => setTimeout(resolve, 4000))])

      const stderrText =
        recorder.stderr && typeof recorder.stderr !== "number"
          ? await Bun.readableStreamToText(recorder.stderr).catch(() => "")
          : ""
      if (looksLikeMicPermissionError(stderrText)) {
        const detail = stderrText
          .split("\n")
          .map((x) => x.trim())
          .filter(Boolean)
          .at(-1)
        const terminalName = currentTerminalName()
        const message =
          process.platform === "darwin"
            ? isLikelyIntegratedTerminal()
              ? `Microphone denied for ${terminalName}. Allow it in System Settings > Privacy & Security > Microphone, or run nikcli in Terminal.app/iTerm2`
              : `Microphone access denied for ${terminalName}. Enable it in System Settings > Privacy & Security > Microphone`
            : "Microphone access denied. Allow microphone permission for your terminal"
        toast.show({
          variant: "error",
          message: detail ? `${message} (${detail})` : message,
          duration: 8000,
        })
        return
      }

      const recordedBytes = await Bun.file(filePath)
        .arrayBuffer()
        .then((x) => x.byteLength)
        .catch(() => 0)

      if (recordedBytes < 1024) {
        const detail = stderrText.trim().split("\n").at(-1)
        toast.show({
          variant: "error",
          message: detail ? `No audio captured: ${detail}` : "No audio captured. Try holding the button longer",
          duration: 5000,
        })
        return
      }

      const transcript = await transcribeVoiceAudio(filePath)
      const withSpacing = input.plainText.length > 0 && !input.plainText.endsWith(" ") ? ` ${transcript}` : transcript
      const nextInput = `${input.plainText}${withSpacing}`

      input.focus()
      input.setText(nextInput)
      setStore("prompt", "input", nextInput)
      autocomplete.onInput(nextInput)
      await Clipboard.copy(transcript).catch(() => {})

      setTimeout(() => {
        input.cursorOffset = nextInput.length
        renderer.requestRender()
      }, 0)

      toast.show({
        variant: "success",
        message: "Voice transcript inserted and copied",
        duration: 2000,
      })
    } catch (error) {
      const message = friendlyErrorMessage(error, "Voice transcription failed")
      toast.show({ variant: "error", message, duration: 4000 })
    } finally {
      cleanupVoiceAudio(filePath)
      setVoiceStatus("idle")
    }
  }

  async function handleVoiceButtonDown() {
    if (props.disabled) return
    if (voiceStatus() === "transcribing") return
    if (voiceStatus() === "recording") {
      await stopVoiceRecording()
      return
    }
    voicePressStartedAt = Date.now()
    await startVoiceRecording()
  }

  async function handleVoiceButtonUp() {
    if (props.disabled) return
    if (Date.now() - voicePressStartedAt < 220) return
    if (voiceStatus() !== "recording") return
    await stopVoiceRecording()
  }

  onCleanup(() => {
    if (interruptResetTimer) {
      clearTimeout(interruptResetTimer)
      interruptResetTimer = undefined
    }
    if (voiceAutoStopTimer) {
      clearTimeout(voiceAutoStopTimer)
      voiceAutoStopTimer = undefined
    }
    if (voiceRecorder) {
      try {
        voiceRecorder.kill("SIGINT")
      } catch {
        try {
          voiceRecorder.kill()
        } catch {
          // ignore
        }
      }
      voiceRecorder = null
    }
    cleanupVoiceAudio(voiceAudioPath)
    voiceAudioPath = null
  })

  const backgroundJobs = createMemo(() => {
    if (!props.sessionID) return [] as ReturnType<typeof sync.background.list>
    return sync.background.list(props.sessionID)
  })

  // Monitors data for prompt frames
  const monitors = createMemo(() => {
    if (!props.sessionID) return [] as MonitorInfo[]
    return getMonitorsSorted(sync, props.sessionID)
  })

  // Combined count for prompt frames visibility
  const totalBgItems = createMemo(() => backgroundJobs().length + monitors().length)

  function openBackgroundSubtasks() {
    if (!props.sessionID) return
    void sync.background.sync(props.sessionID)
    command.trigger("session.bg_agents")
  }

  // Surface completion with a toast, but do not steal focus from the user.
  const previousSubtaskStatus = new Map<string, string>()
  createEffect(() => {
    if (!props.sessionID) return

    const jobs = backgroundJobs()
    const live = new Set(jobs.map((job) => job.rootDelegationID))
    for (const existing of previousSubtaskStatus.keys()) {
      if (!live.has(existing)) previousSubtaskStatus.delete(existing)
    }

    for (const job of jobs) {
      const current = job.status
      const prev = previousSubtaskStatus.get(job.rootDelegationID)
      previousSubtaskStatus.set(job.rootDelegationID, current)
      if (!prev) continue
      const finished = ["complete", "error", "cancelled", "timeout", "orphaned"].includes(current)
      const wasActive = !["complete", "error", "cancelled", "timeout", "orphaned"].includes(prev)
      if (wasActive && finished) {
        toast.show({
          variant: current === "complete" ? "success" : "warning",
          message: `${job.title || "Background task"} ${current === "complete" ? "finished" : current}`,
          duration: 3000,
        })
      }
    }
  })

  const getAvailableAds = () => {
    const adsConfig = ads()
    const items = (adsConfig?.items ?? []).filter((item: { enabled?: boolean }) => item.enabled !== false)
    const enabled = adsConfig?.enabled ?? true
    if (!enabled || items.length === 0) return []
    return items
  }

  const selectNextAd = () => {
    const items = getAvailableAds()
    if (items.length === 0) {
      setCurrentAd(null)
      return
    }

    const adsConfig = ads()
    const ratio = adsConfig?.ratio ?? 0.3
    if (Math.random() >= ratio) {
      setCurrentAd(null)
      return
    }

    const index = store.currentAdIndex % items.length
    const item = items[index]
    setStore("currentAdIndex", (store.currentAdIndex + 1) % items.length)

    if (item.url) setCurrentAd(`${item.text} {highlight}${item.url}{/highlight}`)
    else setCurrentAd(item.text)
  }

  createEffect(
    on(
      () => status(),
      (currentStatus) => {
        if (currentStatus.type === "idle") {
          selectNextAd()
        }
      },
      { defer: true },
    ),
  )

  const sponsoredTip = currentAd

  const parseTipParts = (tip: string) => {
    const parts: { text: string; highlight: boolean }[] = []
    const regex = /\{highlight\}(.*?)\{\/highlight\}/g
    let lastIndex = 0
    for (const match of tip.matchAll(regex)) {
      if (match.index! > lastIndex) {
        parts.push({
          text: tip.slice(lastIndex, match.index),
          highlight: false,
        })
      }
      parts.push({ text: match[1], highlight: true })
      lastIndex = match.index! + match[0].length
    }
    if (lastIndex < tip.length) {
      parts.push({ text: tip.slice(lastIndex), highlight: false })
    }
    return parts
  }

  function promptModelWarning() {
    toast.show({
      variant: "warning",
      message: "Connect a provider to send prompts",
      duration: 3000,
    })
    if (sync.data.provider.length === 0) {
      dialog.replace(() => <DialogProviderConnect />)
    }
  }

  const textareaKeybindings = useTextareaKeybindings()

  const fileStyleId = syntax().getStyleId("extmark.file")!
  const agentStyleId = syntax().getStyleId("extmark.agent")!
  const pasteStyleId = syntax().getStyleId("extmark.paste")!
  let promptPartTypeId = 0

  sdk.event.on(TuiEventName.promptAppend, (evt) => {
    input.insertText(evt.properties.text)
    setTimeout(() => {
      input.getLayoutNode().markDirty()
      input.gotoBufferEnd()
      renderer.requestRender()
    }, 0)
  })

  createEffect(
    on(
      () => [props.disabled, theme.surface.offset, theme.foreground.default] as const,
      ([disabled, bg, text]) => {
        if (disabled) input.cursorColor = bg
        if (!disabled) input.cursorColor = text
      },
      { defer: true },
    ),
  )

  const lastUserMessage = createMemo(() => {
    if (!props.sessionID) return undefined
    const messages = sync.data.message[props.sessionID]
    if (!messages) return undefined
    return messages.findLast((m) => m.role === "user")
  })

  const usage = createMemo(() => {
    if (!props.sessionID) return
    const msg = sync.data.message[props.sessionID] ?? []
    const last = msg.findLast((item): item is AssistantMessage => item.role === "assistant" && item.tokens.output > 0)
    if (!last) return

    const tokens =
      last.tokens.input + last.tokens.output + last.tokens.reasoning + last.tokens.cache.read + last.tokens.cache.write
    if (tokens <= 0) return

    const model = sync.data.provider.find((item) => item.id === last.providerID)?.models[last.modelID]
    const pct = model?.limit.context ? `${Math.round((tokens / model.limit.context) * 100)}%` : undefined
    const cost = msg.reduce((sum, item) => sum + (item.role === "assistant" ? item.cost : 0), 0)
    return {
      context: pct ? `${Locale.number(tokens)} (${pct})` : Locale.number(tokens),
      cost: cost > 0 ? money.format(cost) : undefined,
    }
  })

  const [store, setStore] = createStore<{
    prompt: PromptInfo
    mode: "normal" | "shell"
    extmarkToPartIndex: Map<number, number>
    interrupt: number
    placeholder: number
    currentAdIndex: number
  }>({
    placeholder: Math.floor(Math.random() * PLACEHOLDER_KEYS.length),
    prompt: {
      input: "",
      parts: [],
    },
    mode: "normal",
    extmarkToPartIndex: new Map(),
    interrupt: 0,
    currentAdIndex: 0,
  })

  createEffect(
    on(
      () => props.sessionID,
      () => {
        setStore("placeholder", Math.floor(Math.random() * PLACEHOLDER_KEYS.length))
        setStore("interrupt", 0)
      },
      { defer: true },
    ),
  )

  createEffect(() => {
    if (status().type === "idle") setStore("interrupt", 0)
  })

  // Initialize agent/model/variant from last user message when session changes
  let syncedSessionID: string | undefined
  createEffect(
    on(
      () => ({ sessionID: props.sessionID, msg: lastUserMessage() }),
      ({ sessionID, msg }) => {
        if (sessionID !== syncedSessionID) {
          if (!sessionID || !msg) return

          syncedSessionID = sessionID

          const isPrimaryAgent = local.agent.list().some((x) => x.name === msg.agent)
          if (msg.agent && isPrimaryAgent) {
            local.agent.set(msg.agent)
            if (msg.model) local.model.set(msg.model)
            if (msg.variant) local.model.variant.set(msg.variant)
          }
        }
      },
      { defer: true },
    ),
  )

  command.register(() => {
    return [
      {
        title: "Clear prompt",
        value: "prompt.clear",
        category: "Prompt",
        hidden: true,
        onSelect: (dialog) => {
          clearComposer()
          dialog.clear()
        },
      },
      {
        title: "Submit prompt",
        value: "prompt.submit",
        category: "Prompt",
        hidden: true,
        onSelect: (dialog) => {
          if (!input.focused) return
          submit()
          dialog.clear()
        },
      },
      {
        title: "Paste",
        value: "prompt.paste",
        keybind: "input_paste",
        category: "Prompt",
        hidden: true,
        onSelect: async () => {
          const content = await Clipboard.read()
          if (content?.mime.startsWith("image/")) {
            await pasteImage({
              filename: "clipboard",
              mime: content.mime,
              content: content.data,
            })
          }
        },
      },
      {
        title: "Interrupt session",
        value: "session.interrupt",
        keybind: "session_interrupt",
        category: "Session",
        hidden: true,
        enabled: status().type !== "idle",
        onSelect: (dialog) => {
          const guardAutocomplete = (autocomplete as AutocompleteRef | undefined)?.visible
          const guardFocused = (input as TextareaRenderable | undefined)?.focused
          const guardShell = store.mode === "shell"
          const guardNoSession = !props.sessionID
          if (guardAutocomplete) return
          if (!guardFocused) return
          if (guardShell) {
            setStore("mode", "normal")
            return
          }
          if (guardNoSession) return

          const newCount = store.interrupt + 1
          setStore("interrupt", newCount)

          if (interruptResetTimer) clearTimeout(interruptResetTimer)
          interruptResetTimer = setTimeout(() => {
            interruptResetTimer = undefined
            try {
              setStore("interrupt", 0)
            } catch {
              // store may be disposed if the component unmounted; ignore
            }
          }, 5000)

          if (newCount >= 2) {
            if (!props.sessionID) return
            const sessionID = props.sessionID
            void sdk.client.session.abort({ sessionID }).catch(() => {})
            setStore("interrupt", 0)
            if (interruptResetTimer) {
              clearTimeout(interruptResetTimer)
              interruptResetTimer = undefined
            }
          }
          dialog.clear()
        },
      },
      {
        title: "Open editor",
        category: "Session",
        keybind: "editor_open",
        value: "prompt.editor",
        slash: {
          name: "editor",
        },
        onSelect: async (dialog) => {
          dialog.clear()

          // replace summarized text parts with the actual text
          const text = store.prompt.parts
            .filter((p) => p.type === "text")
            .reduce((acc, p) => {
              if (!p.source) return acc
              return acc.replace(p.source.text.value, p.text)
            }, store.prompt.input)

          const nonTextParts = store.prompt.parts.filter((p) => p.type !== "text")

          const value = text
          const content = await Editor.open({ value, renderer })
          if (!content) return

          input.setText(content)

          // Update positions for nonTextParts based on their location in new content
          // Filter out parts whose virtual text was deleted
          // this handles a case where the user edits the text in the editor
          // such that the virtual text moves around or is deleted
          const updatedNonTextParts = nonTextParts
            .map((part) => {
              let virtualText = ""
              if (part.type === "file" && part.source?.text) {
                virtualText = part.source.text.value
              } else if (part.type === "agent" && part.source) {
                virtualText = part.source.value
              }

              if (!virtualText) return part

              const newStart = content.indexOf(virtualText)
              // if the virtual text is deleted, remove the part
              if (newStart === -1) return null

              const newEnd = newStart + virtualText.length

              if (part.type === "file" && part.source?.text) {
                return {
                  ...part,
                  source: {
                    ...part.source,
                    text: {
                      ...part.source.text,
                      start: newStart,
                      end: newEnd,
                    },
                  },
                }
              }

              if (part.type === "agent" && part.source) {
                return {
                  ...part,
                  source: {
                    ...part.source,
                    start: newStart,
                    end: newEnd,
                  },
                }
              }

              return part
            })
            .filter((part) => part !== null)

          setStore("prompt", {
            input: content,
            // keep only the non-text parts because the text parts were
            // already expanded inline
            parts: updatedNonTextParts,
          })
          restoreExtmarksFromParts(updatedNonTextParts)
          input.cursorOffset = Bun.stringWidth(content)
        },
      },
    ]
  })

  const ref: PromptRef = {
    get focused() {
      return input.focused
    },
    get current() {
      return store.prompt
    },
    focus() {
      input.focus()
    },
    blur() {
      input.blur()
    },
    set(prompt) {
      input.setText(prompt.input)
      setStore("prompt", prompt)
      restoreExtmarksFromParts(prompt.parts)
      input.gotoBufferEnd()
    },
    reset() {
      clearComposer()
      setStore("prompt", {
        input: "",
        parts: [],
      })
      setStore("extmarkToPartIndex", new Map())
    },
    submit() {
      submit()
    },
  }

  createEffect(
    on(
      () => props.visible,
      (visible) => {
        if (visible !== false) input?.focus()
        if (visible === false) input?.blur()
      },
    ),
  )

  onMount(() => {
    // Ensure the prompt owns OpenTUI focus on first paint (mobile PTY has no mouse autoFocus).
    if (props.visible !== false) {
      queueMicrotask(() => {
        if (!input?.isDestroyed) input?.focus()
      })
    }
  })

  function restoreExtmarksFromParts(parts: PromptInfo["parts"]) {
    const current = liveComposer()
    if (!current) return
    current.extmarks.clear()
    setStore("extmarkToPartIndex", new Map())

    parts.forEach((part, partIndex) => {
      let start = 0
      let end = 0
      let virtualText = ""
      let styleId: number | undefined

      if (part.type === "file" && part.source?.text) {
        start = part.source.text.start
        end = part.source.text.end
        virtualText = part.source.text.value
        styleId = fileStyleId
      } else if (part.type === "agent" && part.source) {
        start = part.source.start
        end = part.source.end
        virtualText = part.source.value
        styleId = agentStyleId
      } else if (part.type === "text" && part.source?.text) {
        start = part.source.text.start
        end = part.source.text.end
        virtualText = part.source.text.value
        styleId = pasteStyleId
      }

      if (virtualText) {
        const extmarkId = current.extmarks.create({
          start,
          end,
          virtual: true,
          styleId,
          typeId: promptPartTypeId,
        })
        setStore("extmarkToPartIndex", (map: Map<number, number>) => {
          const newMap = new Map(map)
          newMap.set(extmarkId, partIndex)
          return newMap
        })
      }
    })
  }

  function syncExtmarksWithPromptParts() {
    const current = liveComposer()
    if (!current) return
    const allExtmarks = current.extmarks.getAllForTypeId(promptPartTypeId)
    setStore(
      produce((draft) => {
        const newMap = new Map<number, number>()
        const newParts: typeof draft.prompt.parts = []

        for (const extmark of allExtmarks) {
          const partIndex = draft.extmarkToPartIndex.get(extmark.id)
          if (partIndex !== undefined) {
            const part = draft.prompt.parts[partIndex]
            if (part) {
              if (part.type === "agent" && part.source) {
                part.source.start = extmark.start
                part.source.end = extmark.end
              } else if (part.type === "file" && part.source?.text) {
                part.source.text.start = extmark.start
                part.source.text.end = extmark.end
              } else if (part.type === "text" && part.source?.text) {
                part.source.text.start = extmark.start
                part.source.text.end = extmark.end
              }
              newMap.set(extmark.id, newParts.length)
              newParts.push(part)
            }
          }
        }

        draft.extmarkToPartIndex = newMap
        draft.prompt.parts = newParts
      }),
    )
  }

  command.register(() => [
    {
      title: "Stash prompt",
      value: "prompt.stash",
      category: "Prompt",
      enabled: !!store.prompt.input,
      onSelect: (dialog) => {
        if (!store.prompt.input) return
        stash.push({
          input: store.prompt.input,
          parts: store.prompt.parts,
        })
        clearComposer()
        setStore("prompt", { input: "", parts: [] })
        setStore("extmarkToPartIndex", new Map())
        dialog.clear()
      },
    },
    {
      title: "Stash pop",
      value: "prompt.stash.pop",
      category: "Prompt",
      enabled: stash.list().length > 0,
      onSelect: (dialog) => {
        const entry = stash.pop()
        if (entry) {
          input.setText(entry.input)
          setStore("prompt", { input: entry.input, parts: entry.parts })
          restoreExtmarksFromParts(entry.parts)
          input.gotoBufferEnd()
        }
        dialog.clear()
      },
    },
    {
      title: "Stash list",
      value: "prompt.stash.list",
      category: "Prompt",
      enabled: stash.list().length > 0,
      onSelect: (dialog) => {
        dialog.replace(() => (
          <DialogStash
            onSelect={(entry) => {
              input.setText(entry.input)
              setStore("prompt", { input: entry.input, parts: entry.parts })
              restoreExtmarksFromParts(entry.parts)
              input.gotoBufferEnd()
            }}
          />
        ))
      },
    },
  ])

  command.register(() => [
    {
      title: "Create Theme",
      value: "theme.create",
      category: "Theme",
      slash: { name: "theme-create" },
      onSelect: (dialog) => {
        dialog.replace(() => <DialogThemeCreate />)
      },
    },
    {
      title: "Image Models",
      value: "image-models",
      category: "Config",
      slash: { name: "image-models" },
      onSelect: (dialog) => {
        dialog.replace(() => <DialogImageModel />)
      },
    },
    {
      title: "TTS Voice",
      value: "speak-model",
      category: "Config",
      slash: { name: "speak-model" },
      onSelect: (dialog) => {
        dialog.replace(() => <DialogSpeakModel />)
      },
    },
    {
      title: "Remote Access",
      value: "remote",
      category: "Config",
      slash: { name: "remote" },
      onSelect: (dialog) => {
        dialog.replace(() => <DialogRemote />)
      },
    },
    {
      title: "Teleport Session",
      value: "teleport",
      category: "Session",
      slash: { name: "teleport" },
      enabled: !!props.sessionID,
      onSelect: (dialog) => {
        if (!props.sessionID) return
        dialog.replace(() => <DialogMobileConnect sessionID={props.sessionID} initialMode="teleport" />)
      },
    },
  ])

  /**
   * Put a rejected submission back in the composer.
   *
   * The composer clears optimistically — the answer arrives over the sync
   * stream, not from the call — so a failed shell or slash command used to
   * delete what the user typed and say nothing. Restoring is skipped once the
   * composer holds anything again: whatever the user is typing now outranks a
   * request that already failed.
   */
  function restoreSubmission(text: string, mode: "normal" | "shell") {
    try {
      if (input.plainText.length > 0) return
      input.setText(text)
      input.gotoBufferEnd()
      setStore("prompt", "input", text)
      setStore("mode", mode)
    } catch {
      // The composer this submission came from is gone — the home prompt
      // navigates to the session route right after submitting. The toast has
      // already told the user; there is nothing left to restore into.
    }
  }

  function reportSubmitFailure(error: unknown, text: string, mode: "normal" | "shell") {
    toast.show({
      message: friendlyErrorMessage(error, "Failed to send — check your connection or provider"),
      variant: "error",
      duration: 5000,
    })
    restoreSubmission(text, mode)
  }

  async function submit(delivery: "queue" | "steer" = "queue") {
    if (props.disabled) return
    if (autocomplete?.visible) return
    if (!store.prompt.input) {
      if (delivery === "steer" && props.sessionID) {
        const queued = sync.session.pending(props.sessionID).find((item) => item.delivery === "queue")
        if (queued) {
          await sync.session.steerPending(props.sessionID, queued.id).catch((err) => {
            toast.show({
              message: err instanceof Error ? err.message : "Failed to send queued message",
              variant: "error",
              duration: 5000,
            })
          })
        }
      }
      return
    }
    const trimmed = store.prompt.input.trim().toLowerCase()
    if (trimmed === "exit" || trimmed === "quit" || trimmed === ":q") {
      exit()
      return
    }
    const selectedModel = local.model.current()
    if (!selectedModel) {
      promptModelWarning()
      return
    }
    const sessionID = props.sessionID
      ? props.sessionID
      : await (async () => {
          const sessionID = await sdk.client.session.create({ workspaceID: props.workspaceID }).then((x) => x.data!.id)
          return sessionID
        })()
    const messageID = Identifier.ascending("message")
    let inputText = store.prompt.input

    // Expand pasted text inline before submitting
    const allExtmarks = input.extmarks.getAllForTypeId(promptPartTypeId)
    const sortedExtmarks = allExtmarks.sort((a: { start: number }, b: { start: number }) => b.start - a.start)

    for (const extmark of sortedExtmarks) {
      const partIndex = store.extmarkToPartIndex.get(extmark.id)
      if (partIndex !== undefined) {
        const part = store.prompt.parts[partIndex]
        if (part?.type === "text" && part.text) {
          const before = inputText.slice(0, extmark.start)
          const after = inputText.slice(extmark.end)
          inputText = before + part.text + after
        }
      }
    }

    // Filter out text parts (pasted content) since they're now expanded inline
    const nonTextParts = store.prompt.parts.filter((part) => part.type !== "text")

    // Capture mode before it gets reset
    const currentMode = store.mode
    const variant = local.model.variant.current()
    const editorSelection = editorContextVisible() ? editor.selection() : undefined
    const editorParts = editorSelection
      ? [
          {
            id: Identifier.ascending("part"),
            type: "text" as const,
            text: (() => {
              const start = editorSelection.selection.start
              const end = editorSelection.selection.end
              if (start.line === end.line && start.character === end.character) {
                return `Note: The user opened the file "${editorSelection.filePath}".`
              }
              if (start.line === end.line) {
                return `Note: The user selected line ${start.line} from  "${editorSelection.filePath}": ${editorSelection.text}`
              }
              return `Note: The user selected lines ${start.line} to ${end.line} from "${editorSelection.filePath}": ${editorSelection.text}`
            })(),
            synthetic: true,
          },
        ]
      : []

    if (store.mode === "shell") {
      void sdk.client.session
        .shell({
          sessionID,
          agent: local.agent.current().name,
          model: {
            providerID: selectedModel.providerID,
            modelID: selectedModel.modelID,
          },
          command: inputText,
        })
        .then(({ error }) => {
          if (error) reportSubmitFailure(error, inputText, "shell")
        })
        .catch((error: unknown) => reportSubmitFailure(error, inputText, "shell"))
      setStore("mode", "normal")
    } else if (
      inputText.startsWith("/") &&
      iife(() => {
        const firstLine = inputText.split("\n")[0]
        const command = firstLine.split(" ")[0].slice(1)
        return sync.data.command.some((x) => x.name === command)
      })
    ) {
      // Parse command from first line, preserve multi-line content in arguments
      const firstLineEnd = inputText.indexOf("\n")
      const firstLine = firstLineEnd === -1 ? inputText : inputText.slice(0, firstLineEnd)
      const [command, ...firstLineArgs] = firstLine.split(" ")
      const restOfInput = firstLineEnd === -1 ? "" : inputText.slice(firstLineEnd + 1)
      const args = firstLineArgs.join(" ") + (restOfInput ? "\n" + restOfInput : "")

      const request = sdk.client.session.command({
        sessionID,
        workspace: activeContext().workspace,
        directory: activeContext().directory,
        command: command.slice(1),
        delivery,
        arguments: args,
        agent: local.agent.current().name,
        model: `${selectedModel.providerID}/${selectedModel.modelID}`,
        messageID,
        variant,
        parts: nonTextParts
          .filter((x) => x.type === "file")
          .map((x) => ({
            id: Identifier.ascending("part"),
            ...x,
          })),
      })
      for (const delay of [100, 500, 1500]) {
        setTimeout(() => void sync.session.refreshPending(sessionID).catch(() => undefined), delay)
      }
      void request
        .then(({ error }) => {
          if (error) {
            reportSubmitFailure(error, inputText, "normal")
            return
          }
          return sync.session.refreshPending(sessionID).catch(() => undefined)
        })
        .catch((error: unknown) => reportSubmitFailure(error, inputText, "normal"))
    } else {
      sdk.client.session
        .promptAsync(
          {
            sessionID,
            workspace: activeContext().workspace,
            directory: activeContext().directory,
            ...selectedModel,
            messageID,
            delivery,
            agent: local.agent.current().name,
            model: selectedModel,
            variant,
            parts: [
              ...editorParts,
              {
                id: Identifier.ascending("part"),
                type: "text",
                text: inputText,
              },
              ...nonTextParts.map((x) => ({
                id: Identifier.ascending("part"),
                ...x,
              })),
            ],
          },
          { throwOnError: true },
        )
        .then(() => sync.session.refreshPending(sessionID).catch(() => undefined))
        .catch((err) => {
          console.error("Failed to send prompt:", err)
          const userError = userFacingParts(err)
          if (userError) {
            toast.show({
              title: userError.title,
              message: `${userError.what}\nTry: ${userError.try}`,
              variant: "error",
              duration: 10000,
            })
          } else {
            toast.show({
              message: "Failed to send — check your connection or provider",
              variant: "error",
              duration: 5000,
            })
          }
        })
    }
    history.append({
      ...store.prompt,
      mode: currentMode,
    })
    clearComposer()
    setStore("prompt", {
      input: "",
      parts: [],
    })
    setStore("extmarkToPartIndex", new Map())
    props.onSubmit?.()

    // temporary hack to make sure the message is sent
    if (!props.sessionID)
      setTimeout(() => {
        route.navigate({
          type: "session",
          sessionID,
          workspaceID: props.workspaceID ?? sync.session.get(sessionID)?.workspaceID,
        })
      }, 50)
  }
  const { exit } = useExit()

  function pasteText(text: string, virtualText: string) {
    const currentOffset = input.visualCursor.offset
    const extmarkStart = currentOffset
    const extmarkEnd = extmarkStart + virtualText.length

    input.insertText(virtualText + " ")

    const extmarkId = input.extmarks.create({
      start: extmarkStart,
      end: extmarkEnd,
      virtual: true,
      styleId: pasteStyleId,
      typeId: promptPartTypeId,
    })

    setStore(
      produce((draft) => {
        const partIndex = draft.prompt.parts.length
        draft.prompt.parts.push({
          type: "text" as const,
          text,
          source: {
            text: {
              start: extmarkStart,
              end: extmarkEnd,
              value: virtualText,
            },
          },
        })
        draft.extmarkToPartIndex.set(extmarkId, partIndex)
      }),
    )
  }

  async function pasteImage(file: { filename?: string; content: string; mime: string }) {
    const currentOffset = input.visualCursor.offset
    const extmarkStart = currentOffset
    const count = store.prompt.parts.filter((x) => x.type === "file").length
    const virtualText = `[Image ${count + 1}]`
    const extmarkEnd = extmarkStart + virtualText.length
    const textToInsert = virtualText + " "

    input.insertText(textToInsert)

    const extmarkId = input.extmarks.create({
      start: extmarkStart,
      end: extmarkEnd,
      virtual: true,
      styleId: pasteStyleId,
      typeId: promptPartTypeId,
    })

    // Opencode #21633: prefer file:// over data: URLs so MCP tools that expect
    // a path on disk can analyze the pasted image. Falls back to data: if the
    // temp write fails (e.g. disk full, permissions).
    let url: string = `data:${file.mime};base64,${file.content}`
    try {
      const os = await import("os")
      const path = await import("path")
      const tmp = path.join(os.tmpdir(), `nikcli-paste-${Date.now()}.${file.mime.split("/")[1] ?? "png"}`)
      const bytes = Buffer.from(file.content, "base64")
      await Bun.write(tmp, bytes)
      url = `file://${tmp}`
    } catch {
      // keep data: fallback
    }

    const part: Omit<FilePart, "id" | "messageID" | "sessionID"> = {
      type: "file" as const,
      mime: file.mime,
      filename: file.filename,
      url,
      source: {
        type: "file",
        path: file.filename ?? "",
        text: {
          start: extmarkStart,
          end: extmarkEnd,
          value: virtualText,
        },
      },
    }
    setStore(
      produce((draft) => {
        const partIndex = draft.prompt.parts.length
        draft.prompt.parts.push(part)
        draft.extmarkToPartIndex.set(extmarkId, partIndex)
      }),
    )
    return
  }

  const highlight = createMemo(() => {
    if (keybind.leader) return theme.border.default
    if (store.mode === "shell") return theme.accent.fg
    return local.agent.color(local.agent.current().name)
  })

  const showVariant = createMemo(() => {
    const variants = local.model.variant.list()
    if (variants.length === 0) return false
    const current = local.model.variant.current()
    return !!current
  })

  // Active goal indicator: green = attivo, yellow = in corso (working),
  // red = errore / fail (blocked or hit a budget/usage limit).
  const goal = createMemo(() => {
    if (!props.sessionID) return undefined
    return sync.data.session_goal?.[props.sessionID]
  })

  const goalDisplay = createMemo(() => {
    const g = goal()
    if (!g) return undefined
    if (g.status === "blocked") return { color: theme.status.error.fg, status: "failed" }
    if (g.status === "usage_limited" || g.status === "budget_limited") {
      return { color: theme.status.error.fg, status: "limited" }
    }
    if (g.status === "complete") return { color: theme.status.success.fg, status: "done" }
    // active / paused: yellow while the agent is actively working it, green otherwise
    const working = status().type === "busy" || status().type === "retry"
    if (working) return { color: theme.status.warning.fg, status: "running" }
    return {
      color: theme.status.success.fg,
      status: g.status === "paused" ? "paused" : "active",
    }
  })

  const spinnerDef = createMemo(() => {
    const style = kv.get("settings.spinner.style", "knight_rider_blocks") as SpinnerStyle
    const enabled = kv.get("settings.spinner.enabled", true)

    if (!enabled) {
      return null
    }

    const color = local.agent.color(local.agent.current().name)

    const brailleFrames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]
    const dotsFrames = ["·", "⠂", "⠄", "⠆", "⠖", "⠗", "⠞", "⠟", "⠿", "⠛"]
    const lineFrames = ["│", "⠐", "⠔", "⠤", "⠄", "⠦"]
    const bouncingFrames = ["①", "②", "③", "④", "⑤", "⑥", "⑦", "⑧"]
    const pulseFrames = ["▖", "▗", "▘", "▙", "▚", "▛", "▜", "▝", "▞", "▟"]

    if (style === "knight_rider_blocks") {
      return {
        frames: createFrames({
          color,
          style: "blocks",
          inactiveFactor: 0.6,
          minAlpha: 0.3,
        }),
        color: createColors({
          color,
          style: "blocks",
          inactiveFactor: 0.6,
          minAlpha: 0.3,
        }),
      }
    }

    if (style === "knight_rider_diamonds") {
      return {
        frames: createFrames({
          color,
          style: "diamonds",
          inactiveFactor: 0.6,
          minAlpha: 0.3,
        }),
        color: createColors({
          color,
          style: "diamonds",
          inactiveFactor: 0.6,
          minAlpha: 0.3,
        }),
      }
    }

    if (style === "braille") {
      return {
        frames: brailleFrames,
        color: undefined,
      }
    }

    if (style === "dots") {
      return {
        frames: dotsFrames,
        color: undefined,
      }
    }

    if (style === "line") {
      return {
        frames: lineFrames,
        color: undefined,
      }
    }

    if (style === "bouncing") {
      return {
        frames: bouncingFrames,
        color: undefined,
      }
    }

    if (style === "pulse") {
      return {
        frames: pulseFrames,
        color: undefined,
      }
    }

    // Default fallback
    return {
      frames: createFrames({
        color,
        style: "blocks",
        inactiveFactor: 0.6,
        minAlpha: 0.3,
      }),
      color: createColors({
        color,
        style: "blocks",
        inactiveFactor: 0.6,
        minAlpha: 0.3,
      }),
    }
  })

  const placeholderText = createMemo(() => {
    if (props.sessionID) return undefined
    if (store.mode === "shell") {
      const example = lang.t(SHELL_PLACEHOLDER_KEYS[store.placeholder % SHELL_PLACEHOLDER_KEYS.length])
      return lang.t("prompt.placeholder.shell", { example })
    }
    const example = lang.t(PLACEHOLDER_KEYS[store.placeholder % PLACEHOLDER_KEYS.length])
    return lang.t("prompt.placeholder.ask", { example })
  })

  return (
    <>
      <Autocomplete
        sessionID={props.sessionID}
        ref={(r) => (autocomplete = r)}
        anchor={() => anchor}
        input={() => input}
        setPrompt={(cb) => {
          setStore("prompt", produce(cb))
        }}
        setExtmark={(partIndex, extmarkId) => {
          setStore("extmarkToPartIndex", (map: Map<number, number>) => {
            const newMap = new Map(map)
            newMap.set(extmarkId, partIndex)
            return newMap
          })
        }}
        value={store.prompt.input}
        fileStyleId={fileStyleId}
        agentStyleId={agentStyleId}
        promptPartTypeId={() => promptPartTypeId}
      />
      <box ref={(r) => (anchor = r)} visible={props.visible !== false}>
        <box
          border={sessionStyle()?.prompt.border === false ? [] : ["left"]}
          borderColor={highlight()}
          customBorderChars={{
            ...SplitBorder.customBorderChars,
            bottomLeft: "╹",
          }}
        >
          <box
            paddingLeft={sessionStyle()?.prompt.paddingX ?? 2}
            paddingRight={sessionStyle()?.prompt.paddingX ?? 2}
            paddingTop={sessionStyle()?.prompt.paddingY ?? 1}
            paddingBottom={sessionStyle()?.prompt.paddingY ?? 0}
            flexShrink={0}
            backgroundColor={promptBackground()}
            flexGrow={1}
          >
            <textarea
              placeholder={placeholderText()}
              textColor={keybind.leader ? theme.foreground.muted : theme.foreground.default}
              focusedTextColor={keybind.leader ? theme.foreground.muted : theme.foreground.default}
              minHeight={1}
              maxHeight={6}
              onContentChange={() => {
                const value = input.plainText
                setStore("prompt", "input", value)
                autocomplete.onInput(value)
                syncExtmarksWithPromptParts()
              }}
              keyBindings={textareaKeybindings()}
              onKeyDown={async (e) => {
                if (props.disabled) {
                  e.preventDefault()
                  return
                }
                if ((e.ctrl || e.super) && (e.name === "return" || e.name === "enter")) {
                  e.preventDefault()
                  await submit("steer")
                  return
                }
                // Handle clipboard paste (Ctrl+V) - check for images first on Windows
                // This is needed because Windows terminal doesn't properly send image data
                // through bracketed paste, so we need to intercept the keypress and
                // directly read from clipboard before the terminal handles it
                if (keybind.match("input_paste", e)) {
                  const content = await Clipboard.read()
                  if (content?.mime.startsWith("image/")) {
                    e.preventDefault()
                    await pasteImage({
                      filename: "clipboard",
                      mime: content.mime,
                      content: content.data,
                    })
                    return
                  }
                  // If no image, let the default paste behavior continue
                }

                if (keybind.match("input_clear", e) && store.prompt.input !== "") {
                  clearComposer()
                  setStore("prompt", {
                    input: "",
                    parts: [],
                  })
                  setStore("extmarkToPartIndex", new Map())
                  return
                }
                if (keybind.match("app_exit", e)) {
                  if (store.prompt.input === "") {
                    await exit()
                    // Don't preventDefault - let textarea potentially handle the event
                    e.preventDefault()
                    return
                  }
                }

                // Background jobs picker (Down arrow when prompt textarea is focused and empty)
                if (
                  input.focused &&
                  !autocomplete.visible &&
                  store.mode === "normal" &&
                  props.sessionID &&
                  store.prompt.input === "" &&
                  totalBgItems() > 0 &&
                  keybind.match("subtask_picker", e)
                ) {
                  e.preventDefault()
                  openBackgroundSubtasks()
                  return
                }
                if (e.name === "!" && input.visualCursor.offset === 0) {
                  setStore("placeholder", Math.floor(Math.random() * SHELL_PLACEHOLDER_KEYS.length))
                  setStore("mode", "shell")
                  e.preventDefault()
                  return
                }
                if (store.mode === "shell") {
                  if ((e.name === "backspace" && input.visualCursor.offset === 0) || e.name === "escape") {
                    setStore("mode", "normal")
                    e.preventDefault()
                    return
                  }
                }
                if (store.mode === "normal") autocomplete.onKeyDown(e)
                if (!autocomplete.visible) {
                  if (
                    (keybind.match("history_previous", e) && input.cursorOffset === 0) ||
                    (keybind.match("history_next", e) && input.cursorOffset === input.plainText.length)
                  ) {
                    const direction = keybind.match("history_previous", e) ? -1 : 1
                    const item = history.move(direction, input.plainText)

                    if (item) {
                      input.setText(item.input)
                      setStore("prompt", item)
                      setStore("mode", item.mode ?? "normal")
                      restoreExtmarksFromParts(item.parts)
                      e.preventDefault()
                      if (direction === -1) input.cursorOffset = 0
                      if (direction === 1) input.cursorOffset = input.plainText.length
                    }
                    return
                  }

                  if (keybind.match("history_previous", e) && input.visualCursor.visualRow === 0) input.cursorOffset = 0
                  if (keybind.match("history_next", e) && input.visualCursor.visualRow === input.height - 1)
                    input.cursorOffset = input.plainText.length

                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  if (keybind.match("voice_record" as any, e)) {
                    e.preventDefault()
                    void handleVoiceButtonDown()
                    return
                  }
                }
              }}
              onSubmit={() => submit("queue")}
              onPaste={async (event: PasteEvent) => {
                if (props.disabled) {
                  event.preventDefault()
                  return
                }

                const text = new TextDecoder().decode(event.bytes)

                // Normalize line endings at the boundary
                // Windows ConPTY/Terminal often sends CR-only newlines in bracketed paste
                // Replace CRLF first, then any remaining CR
                const normalizedText = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n")
                const pastedContent = normalizedText.trim()
                if (!pastedContent) {
                  command.trigger("prompt.paste")
                  return
                }

                // Skip whitespace-only pastes
                if (!pastedContent.trim()) {
                  event.preventDefault()
                  return
                }

                // trim ' from the beginning and end of the pasted content. just
                // ' and nothing else
                const filepath = pastedContent.replace(/^'+|'+$/g, "").replace(/\\ /g, " ")
                const isUrl = /^(https?):\/\//.test(filepath)
                if (!isUrl) {
                  try {
                    const file = Bun.file(filepath)
                    // Handle SVG as raw text content, not as base64 image
                    if (file.type === "image/svg+xml") {
                      event.preventDefault()
                      const content = await file.text().catch(() => {})
                      if (content) {
                        pasteText(content, `[SVG: ${file.name ?? "image"}]`)
                        return
                      }
                    }
                    if (file.type.startsWith("image/")) {
                      event.preventDefault()
                      const content = await file
                        .arrayBuffer()
                        .then((buffer) => Buffer.from(buffer).toString("base64"))
                        .catch((err) => {
                          console.error("Failed to send prompt:", err)
                          toast.show({
                            message: "Failed to send — check your connection or provider",
                            variant: "error",
                            duration: 5000,
                          })
                        })
                      if (content) {
                        await pasteImage({
                          filename: file.name,
                          mime: file.type,
                          content,
                        })
                        return
                      }
                    }
                  } catch {}
                }

                const lineCount = (pastedContent.match(/\n/g)?.length ?? 0) + 1
                if (
                  (lineCount >= 3 || pastedContent.length > 150) &&
                  !sync.data.config.experimental?.disable_paste_summary
                ) {
                  event.preventDefault()
                  pasteText(pastedContent, `[Pasted ~${lineCount} lines]`)
                  return
                }

                // Force layout update and render for the pasted content
                setTimeout(() => {
                  input.getLayoutNode().markDirty()
                  renderer.requestRender()
                }, 0)
              }}
              ref={(r: TextareaRenderable) => {
                input = r
                if (promptPartTypeId === 0) {
                  promptPartTypeId = input.extmarks.registerType("prompt-part")
                }
                props.ref?.(ref)
                setTimeout(() => {
                  input.cursorColor = theme.foreground.default
                }, 0)
              }}
              onMouseDown={(r: MouseEvent) => r.target?.focus()}
              focusedBackgroundColor={theme.surface.offset}
              cursorColor={theme.foreground.default}
              syntaxStyle={syntax()}
            />
            <box flexDirection="row" flexShrink={0} paddingTop={sessionStyle()?.prompt.paddingY ?? 1} gap={1}>
              <Show when={kv.get("show_agent", true)}>
                <text fg={highlight()}>
                  {store.mode === "shell" ? lang.t("prompt.shell") : Locale.titlecase(local.agent.current().name)}{" "}
                </text>
              </Show>
              <Show when={store.mode === "normal" && kv.get("show_agent", true)}>
                <box flexDirection="row" gap={1}>
                  <text fg={theme.foreground.muted}>·</text>
                  <text fg={permissionModeColor(permissionMode(), theme)}>
                    {permissionModeShortLabel(permissionMode())}
                  </text>
                </box>
              </Show>
              <Show when={store.mode === "normal" && kv.get("show_model", true)}>
                <box flexDirection="row" gap={1}>
                  <text flexShrink={0} fg={keybind.leader ? theme.foreground.muted : theme.foreground.default}>
                    {local.model.parsed().model}
                  </text>
                  <text fg={theme.foreground.muted}>{local.model.parsed().provider}</text>
                  <Show when={showVariant()}>
                    <text fg={theme.foreground.muted}>·</text>
                    <text>
                      <span style={{ fg: theme.status.warning.fg, bold: true }}>{local.model.variant.current()}</span>
                    </text>
                  </Show>
                </box>
              </Show>
              <Show when={goalDisplay()}>
                {(g) => (
                  <box flexDirection="row" gap={1} flexShrink={0}>
                    <text fg={theme.foreground.muted}>·</text>
                    <text fg={g().color} wrapMode="none">
                      <span style={{ bold: true }}>goal</span>{" "}
                      <span style={{ fg: theme.foreground.muted }}>{g().status}</span>
                    </text>
                  </box>
                )}
              </Show>
            </box>
          </box>
        </box>
        <box
          height={1}
          border={sessionStyle()?.prompt.border === false ? [] : ["left"]}
          borderColor={highlight()}
          customBorderChars={{
            ...EmptyBorder,
            vertical: promptBackground().a !== 0 ? "╹" : " ",
          }}
        >
          <box
            height={1}
            border={["bottom"]}
            borderColor={promptBackground()}
            customBorderChars={
              promptBackground().a !== 0
                ? {
                    ...EmptyBorder,
                    horizontal: "▀",
                  }
                : {
                    ...EmptyBorder,
                    horizontal: " ",
                  }
            }
          />
        </box>
        <box flexDirection="row" justifyContent="space-between">
          <Show
            when={status().type !== "idle"}
            fallback={
              <box flexDirection="row" gap={2} flexGrow={1} alignItems="center">
                <Show when={props.sessionID && totalBgItems() > 0}>
                  <PromptJobsInlineCompact
                    sessionID={props.sessionID ?? ""}
                    jobs={backgroundJobs()}
                    monitors={monitors()}
                    onOpenBgAgents={() => openBackgroundSubtasks()}
                  />
                </Show>
                <Show when={sponsoredTip() && kv.get("show_sponsored", true)}>
                  <text fg={theme.status.warning.fg}>·</text>
                  <text fg={theme.foreground.muted}>Sponsored:</text>
                  <text fg={theme.foreground.default}>
                    <For each={parseTipParts(sponsoredTip()!)}>
                      {(part) => (
                        <span
                          style={{
                            fg: part.highlight ? theme.foreground.default : theme.foreground.muted,
                          }}
                        >
                          {part.text}
                        </span>
                      )}
                    </For>
                  </text>
                </Show>
              </box>
            }
          >
            <box
              flexDirection="row"
              gap={1}
              flexGrow={1}
              justifyContent={status().type === "retry" ? "space-between" : "flex-start"}
            >
              <box flexShrink={0} flexDirection="row" gap={1}>
                <box marginLeft={1}>
                  <Show
                    when={kv.get("animations_enabled", true) && spinnerDef()}
                    fallback={<text fg={theme.foreground.muted}>[⋯]</text>}
                  >
                    <spinner color={spinnerDef()!.color} frames={spinnerDef()!.frames} interval={40} />
                  </Show>
                </box>
                <box flexDirection="row" gap={1} flexShrink={0}>
                  {(() => {
                    const retry = createMemo(() => {
                      const s = status()
                      if (s.type !== "retry") return
                      return s
                    })
                    const message = createMemo(() => {
                      const r = retry()
                      if (!r) return
                      if (r.message.includes("exceeded your current quota") && r.message.includes("gemini"))
                        return "gemini is way too hot right now"
                      if (r.message.length > 80) return r.message.slice(0, 80) + "..."
                      return r.message
                    })
                    const isTruncated = createMemo(() => {
                      const r = retry()
                      if (!r) return false
                      return r.message.length > 120
                    })
                    const [seconds, setSeconds] = createSignal(0)
                    onMount(() => {
                      const timer = setInterval(() => {
                        const next = retry()?.next
                        if (next) setSeconds(Math.round((next - Date.now()) / 1000))
                      }, 1000)

                      onCleanup(() => {
                        clearInterval(timer)
                      })
                    })
                    const handleMessageClick = () => {
                      const r = retry()
                      if (!r) return
                      if (isTruncated()) {
                        DialogAlert.show(dialog, "Retry Error", r.message)
                      }
                    }

                    const retryText = () => {
                      const r = retry()
                      if (!r) return ""
                      const baseMessage = message()
                      const truncatedHint = isTruncated() ? " (click to expand)" : ""
                      const duration = formatDuration(seconds())
                      const retryInfo = ` [retrying ${duration ? `in ${duration} ` : ""}attempt #${r.attempt}]`
                      return baseMessage + truncatedHint + retryInfo
                    }

                    return (
                      <Show when={retry()}>
                        <box onMouseUp={handleMessageClick}>
                          <text fg={theme.status.error.fg}>{retryText()}</text>
                        </box>
                      </Show>
                    )
                  })()}
                </box>
              </box>
              <box flexDirection="row" gap={2} flexGrow={1} alignItems="center">
                <Show when={props.sessionID && totalBgItems() > 0}>
                  <PromptJobsInlineCompact
                    sessionID={props.sessionID ?? ""}
                    jobs={backgroundJobs()}
                    monitors={monitors()}
                    onOpenBgAgents={() => openBackgroundSubtasks()}
                  />
                </Show>
                <text fg={store.interrupt > 0 ? theme.accent.fg : theme.foreground.default}>
                  esc{" "}
                  <span
                    style={{
                      fg: store.interrupt > 0 ? theme.accent.fg : theme.foreground.muted,
                    }}
                  >
                    {store.interrupt > 0 ? lang.t("prompt.interruptAgain") : lang.t("prompt.interrupt")}
                  </span>
                </text>
                <Show when={sponsoredTip() && kv.get("show_sponsored", true)}>
                  <text fg={theme.status.warning.fg}>·</text>
                  <text fg={theme.foreground.muted}>Sponsored:</text>
                  <text fg={theme.foreground.default}>
                    <For each={parseTipParts(sponsoredTip()!)}>
                      {(part) => (
                        <span
                          style={{
                            fg: part.highlight ? theme.foreground.default : theme.foreground.muted,
                          }}
                        >
                          {part.text}
                        </span>
                      )}
                    </For>
                  </text>
                </Show>
              </box>
            </box>
          </Show>
          <Show when={status().type !== "retry"}>
            {/* Replaceable footer: a plugin registering `prompt.footer` owns
                this row; with none registered the built-in row below renders. */}
            <TuiPluginRuntime.Slot
              name="prompt.footer"
              mode="replace"
              sessionID={props.sessionID}
              promptMode={store.mode}
              busy={status().type !== "idle"}
            >
              {/* alignItems center so the colored rec/web chips never stretch to
                the row height when a sibling (shortcuts) wraps on a narrow
                terminal — they kept their bg fill but grew several rows tall. */}
              <box gap={2} flexDirection="row" alignItems="center">
                <box
                  onMouseDown={() => {
                    void handleVoiceButtonDown()
                  }}
                  onMouseUp={() => {
                    void handleVoiceButtonUp()
                  }}
                  backgroundColor={theme.status.error.fg}
                  paddingLeft={0.5}
                  paddingRight={0.5}
                  flexShrink={0}
                >
                  <text fg={theme.surface.base} wrapMode="none">
                    <span style={{ bold: voiceStatus() === "recording" }}>
                      {voiceStatus() === "recording"
                        ? "release to send"
                        : voiceStatus() === "transcribing"
                          ? "wait"
                          : (() => {
                              // eslint-disable-next-line @typescript-eslint/no-explicit-any
                              const shortcut = keybind.print("voice_record" as any)
                              return shortcut ? (
                                <>
                                  ⏺ <span style={{ fg: theme.foreground.muted }}>rec</span>
                                </>
                              ) : (
                                "⏺"
                              )
                            })()}
                    </span>
                  </text>
                </box>

                <box
                  onMouseUp={() => {
                    dialog.replace(() => <DialogWebPreview />)
                  }}
                  backgroundColor={theme.accent.fg}
                  paddingLeft={1}
                  paddingRight={1}
                  flexShrink={0}
                >
                  <text fg={theme.surface.base} wrapMode="none">
                    ⊕ <span style={{ fg: theme.surface.base }}>web</span>
                  </text>
                </box>

                <Show when={kv.get("show_shortcuts", true)}>
                  <box gap={2} flexDirection="row">
                    <Switch>
                      <Match when={store.mode === "normal"}>
                        <Switch>
                          <Match when={usage()}>
                            {(item) => (
                              <text
                                fg={theme.foreground.muted}
                                wrapMode="none"
                                onMouseUp={() => command.trigger("nikcli.usage")}
                              >
                                {[item().context, item().cost].filter(Boolean).join(" · ")}
                              </text>
                            )}
                          </Match>
                          <Match when={true}>
                            <text fg={theme.foreground.default}>
                              {keybind.print("command_list")}{" "}
                              <span style={{ fg: theme.foreground.muted }}>{lang.t("prompt.commands")}</span>
                            </text>
                          </Match>
                        </Switch>
                      </Match>
                      <Match when={store.mode === "shell"}>
                        <text fg={theme.foreground.default}>
                          esc <span style={{ fg: theme.foreground.muted }}>{lang.t("prompt.exitShellMode")}</span>
                        </text>
                      </Match>
                    </Switch>
                  </box>
                </Show>
                <Show when={editorContextVisible() && editorFileLabelDisplay()}>
                  {(file) => (
                    <text fg={theme.accent.secondary} flexShrink={0} wrapMode="none">
                      {file()}
                    </text>
                  )}
                </Show>
              </box>
            </TuiPluginRuntime.Slot>
          </Show>
        </box>
      </box>
    </>
  )
}
