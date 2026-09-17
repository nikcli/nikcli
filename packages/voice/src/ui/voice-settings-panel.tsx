/**
 * Voice settings control panel component.
 *
 * Provides a fully accessible, keyboard-operable interface for configuring
 * operational modes, trigger activations, shortcut chords, languages,
 * and recognition backends — plus a live console that exercises the engine
 * without leaving the panel.
 *
 * Guarantees:
 * - Does not perform its own validation or persistence; bubbles changes via props.onChange.
 * - Adheres strictly to ADE design tokens and reduced motion preferences.
 * - Protects OpenRouter API credentials from cleartext rendering.
 * - Every control is reachable and operable from the keyboard alone: radio groups
 *   answer to arrows/Home/End, text fields commit on Enter and revert on Escape.
 * - Strictly typed without type assertions or compiler suppression annotations.
 */

import { REPLY_VOICE_CHOICES } from "../settings/reply-voices"
import {
  createEffect,
  createMemo,
  createSignal,
  For,
  onCleanup,
  onMount,
  Show,
  type JSX,
} from "solid-js"
import type { VoiceEngine } from "../engine"
import type { DialogStatus } from "../dialog/session"
import {
  DEFAULT_VOICE_SETTINGS,
  wakeWordEnabled,
  shortcutActivationEnabled,
  type AgentEngine,
  type AgentSpeed,
  type ReplyVoice,
  type ParakeetExecutionBackend,
  type TranscriptionSendMode,
  type VoiceActivation,
  type VoiceMode,
  type VoiceSettings,
} from "../settings/model"
import {
  availableLanguages,
  isLanguageSupported,
  type LanguageOption,
} from "../settings/languages"
import {
  describeShortcut,
  VOICE_COMMAND_AGENT,
  VOICE_COMMAND_TRANSCRIPTION,
} from "../settings/shortcuts"
import { describeBackends, type TranscriberBackend } from "../asr/select"
import {
  disposeParakeetModel,
  isWasmAvailable,
  isWebGpuAvailable,
  warmupParakeetModel,
  type ParakeetProgress,
} from "../asr/parakeet-local"
import {
  clearModelCache,
  downloadParakeetModel,
  EMPTY_CACHE,
  inspectModelCache,
  type CachedModel,
  type DownloadParakeetProgress,
} from "../asr/model-cache"
import {
  describeChoice,
  listAudioDevices,
  onDeviceChange,
  SYSTEM_DEFAULT,
  type AudioDevices,
} from "../audio/devices"
import { VOCABULARY } from "../intent/vocabulary"
import type { Binding } from "@nikcli-ai/ade/keyboard/keymap"
import {
  captureKeyboardEvent,
  checkShortcutConflict,
  formatMaskedApiKey,
  getPlatform,
  suggestClosestLanguage,
} from "./shortcut-capture"
import { NikMic } from "./nik-mic"
import "./voice-settings.css"
import { t } from "@nikcli-ai/ade/i18n"

/**
 * A settings screen the host owns.
 *
 * Same shape as the built-in sections so the rail draws one list: an entry
 * that looked different would announce that it came from somewhere else,
 * which is the thing this panel exists to stop doing.
 */
export interface ExtraSection {
  /** Element id, also used as the rail's current-section key. */
  id: string
  label: string
  /** One or two characters, drawn in the rail beside the label. */
  glyph: string
  /** The summary the rail shows, for a section that has one to show. */
  value?: string
  /** The screen itself, rendered inside the panel's body. */
  render: () => JSX.Element
}

export interface VoiceSettingsPanelProps {
  /** The voice control engine instance. */
  engine: VoiceEngine
  /** Current voice settings. */
  settings: VoiceSettings
  /** Upward notification callback fired when any configuration setting changes. */
  onChange: (next: VoiceSettings) => void
  /** Optional callback fired when the panel requests closing. */
  onClose?: () => void
  /**
   * What changed under the user in this profile, shown where they can undo it.
   *
   * The startup strip says it once and is dismissed; a rule that changed how
   * the microphone answers has to be readable next to the switch that turns
   * it back, or the only way to find out is to wonder why nothing replies.
   */
  settingsNotice?: string
  /** Optional existing ADE keymap bindings to evaluate for shortcut collision. */
  existingBindings?: readonly Binding[]
  /** Opens the page of a Piper voice's model, where its licence is stated. Absent: no link is shown. */
  onOpenVoiceSource?: (voice: ReplyVoice) => void
  /** Optional Parakeet neural model download progress. */
  parakeetProgress?: ParakeetProgress
  /** Optional cost of the most recent speech transcription request. */
  lastCost?: number
  /**
   * Sections contributed by the host, listed in the rail after the voice ones.
   *
   * ADE has one settings panel, not one per subsystem: a second rail-based
   * panel opened by a second button would be two answers to "where are the
   * settings", and the user would have to remember which half of the answer
   * they wanted. The plugins live here for that reason, and anything else
   * that needs a settings screen arrives the same way — already rendered, so
   * this package keeps knowing about voice and nothing else.
   */
  extraSections?: readonly ExtraSection[]
  /**
   * Heading drawn in the rail above this panel's own six screens.
   *
   * Optional, and absent by default, because a heading over a list that is
   * the whole list says nothing. It earns its place once the host adds
   * sections of its own: the reader then needs to be told which rows are the
   * microphone's and which are the application's.
   */
  builtInGroup?: string
  /** The same, above {@link extraSections}. */
  extraGroup?: string
  /** Title shown in the header. Defaults to the voice-only wording. */
  title?: string
  /** The line under the title. Defaults to a description of the voice screens. */
  subtitle?: string
  /** Whether the panel is rendered as a standalone inline component rather than an overlay dialog. */
  inline?: boolean
  /** Optional additional CSS class names. */
  class?: string
}

/**
 * The panel's own table of contents, in render order.
 *
 * Kept as data rather than as markup so the rail and the sections read from
 * one list and cannot drift apart.
 *
 * These were numbered steps once, shown above a single scroller that held all
 * six at once. They were never a sequence — nobody configures a language
 * before an engine because the engine came fifth — and numbering them said
 * they were. In a rail they are places, so each one carries a glyph and the
 * value it currently holds instead: the rail then answers "what is this set
 * to?" without opening anything, which is the question asked most often and
 * the one the old layout charged three screens of scrolling to answer.
 */
const SECTIONS: readonly {
  id: string
  readonly label: string
  glyph: string
  value: (settings: VoiceSettings) => string
}[] = [
  {
    id: "voice-sec-mode",
    get label() { return t("vui.rail.mode") },
    glyph: "◉",
    value: (s) => (s.mode === "agent" ? t("vui.rail.mode.agent") : t("vui.rail.mode.transcription")),
  },
  {
    id: "voice-sec-activation",
    get label() { return t("vui.rail.activation") },
    glyph: "⌁",
    value: (s) =>
      s.activation === "push-to-talk" ? t("vui.rail.activation.push") : s.activation === "toggle" ? t("vui.rail.activation.toggle") : t("vui.rail.activation.wake"),
  },
  {
    id: "voice-sec-shortcuts",
    get label() { return t("vui.rail.shortcuts") },
    glyph: "⌨",
    // Two chords, always: the count is here to keep the column even, not to
    // report a number that varies.
    value: () => "2",
  },
  {
    id: "voice-sec-language",
    get label() { return t("vui.rail.language") },
    glyph: "✱",
    value: (s) => s.language,
  },
  {
    id: "voice-sec-devices",
    label: "Audio",
    glyph: "⊙",
    /* Which of the two has been moved off the default, rather than a device
       name: the rail is one short column and a device is called things like
       "Microfono (2- Realtek(R) Audio)". */
    value: (s) => (s.inputDeviceId ? (s.outputDeviceId ? "2" : "1") : s.outputDeviceId ? "1" : t("vui.rail.devices.system")),
  },
  {
    id: "voice-sec-backend",
    get label() { return t("vui.rail.engine") },
    glyph: "◆",
    value: (s) => (s.backend === "openrouter" ? "mai2" : s.backend),
  },
  {
    id: "voice-sec-commands",
    get label() { return t("vui.rail.commands") },
    glyph: "≡",
    value: () => String(VOCABULARY.length),
  },
]

/**
 * Fixed silhouette for the level meter.
 *
 * A single amplitude drives every bar, so without a per-bar weight the meter
 * would rise and fall as one solid block. These weights give it the shape of a
 * voice without pretending to be a spectrum it never measured.
 */
const METER_WEIGHTS: readonly number[] = [
  0.28, 0.48, 0.70, 0.92, 0.66, 0.86, 1.0, 0.78,
  0.94, 0.60, 0.88, 0.72, 0.50, 0.82, 0.40, 0.24,
]

interface StatusDescriptor {
  label: string
  tone: "off" | "ready" | "live" | "warn" | "busy"
  detail: string
}

function describeStatus(status: DialogStatus, running: boolean): StatusDescriptor {
  if (!running) {
    return {
      label: t("vui.status.off"),
      tone: "off",
      detail: t("vui.status.off.detail"),
    }
  }
  switch (status) {
    case "asleep":
      return {
        label: t("vui.status.asleep"),
        tone: "warn",
        detail: t("vui.status.asleep.detail"),
      }
    case "idle":
      return { label: t("vui.status.idle"), tone: "ready", detail: t("vui.status.idle.detail") }
    case "listening":
      return { label: t("vui.status.listening"), tone: "live", detail: t("vui.status.listening.detail") }
    case "confirming":
      return {
        label: t("vui.status.confirming"),
        tone: "warn",
        detail: t("vui.status.confirming.detail"),
      }
    case "dictating":
      return {
        label: t("vui.status.dictating"),
        tone: "live",
        detail: t("vui.status.dictating.detail"),
      }
    case "executing":
      return { label: t("vui.status.executing"), tone: "busy", detail: t("vui.status.executing.detail") }
  }
}

/**
 * Selects the radio addressed by a keyboard event inside one radio group.
 *
 * Arrow keys move and select in the same motion, which is what a radio group is
 * specified to do; Home and End jump to the ends. Radios belonging to a nested
 * group are excluded so the engine pills never steal the backend list's arrows.
 */
/** The agent engines, as the panel offers them. */
const AGENT_ENGINE_CHOICES: readonly { value: AgentEngine; readonly title: string; readonly desc: string }[] = [
  { value: "auto", get title() { return t("vui.engine.auto") }, get desc() { return t("vui.engine.auto.desc") } },
  { value: "claude", title: "Claude Code", get desc() { return t("vui.engine.claude.desc") } },
  { value: "codex", title: "Codex", get desc() { return t("vui.engine.codex.desc") } },
  { value: "nikcli", title: "nikcli", get desc() { return t("vui.engine.nikcli.desc") } },
  { value: "off", get title() { return t("vui.engine.off") }, get desc() { return t("vui.engine.off.desc") } },
]

const AGENT_SPEED_CHOICES: readonly { value: AgentSpeed; readonly title: string; readonly desc: string }[] = [
  { value: "fast", get title() { return t("vui.speed.fast") }, get desc() { return t("vui.speed.fast.desc") } },
  { value: "cli", get title() { return t("vui.speed.cli") }, get desc() { return t("vui.speed.cli.desc") } },
]

function radioGroupKeys(apply: (value: string) => void) {
  return (event: KeyboardEvent) => {
    const group = event.currentTarget
    if (!(group instanceof HTMLElement)) return
    const origin = event.target
    if (!(origin instanceof HTMLElement)) return
    const radio = origin.closest<HTMLElement>('[role="radio"]')
    // A radio belonging to a nested group (the engine pills) is that group's
    // business: swallowing its keys here would leave it unusable.
    if (!radio || radio.closest('[role="radiogroup"]') !== group) return

    if (event.key === " " || event.key === "Enter") {
      event.preventDefault()
      if (radio.getAttribute("aria-disabled") !== "true") {
        const value = radio.getAttribute("data-value")
        if (value) apply(value)
      }
      return
    }

    const forward = event.key === "ArrowRight" || event.key === "ArrowDown"
    const backward = event.key === "ArrowLeft" || event.key === "ArrowUp"
    if (!forward && !backward && event.key !== "Home" && event.key !== "End") return

    const radios = Array.from(
      group.querySelectorAll<HTMLElement>('[role="radio"]'),
    ).filter(
      (candidate) =>
        candidate.closest('[role="radiogroup"]') === group &&
        candidate.getAttribute("aria-disabled") !== "true",
    )
    if (radios.length === 0) return

    event.preventDefault()
    const index = radios.indexOf(radio)
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? radios.length - 1
          : forward
            ? (index + 1 + radios.length) % radios.length
            : (index - 1 + radios.length) % radios.length

    const target = radios[next]
    target.focus()
    const value = target.getAttribute("data-value")
    if (value) apply(value)
  }
}

export function VoiceSettingsPanel(props: VoiceSettingsPanelProps) {
  const platform = getPlatform()
  let panelRef: HTMLDivElement | undefined
  let bodyRef: HTMLDivElement | undefined

  // Active shortcut recording state
  const [recordingField, setRecordingField] = createSignal<
    "agent" | "transcription" | null
  >(null)
  const [agentConflict, setAgentConflict] = createSignal<string | null>(null)
  const [transcriptionConflict, setTranscriptionConflict] = createSignal<
    string | null
  >(null)
  /*
   * A chord that was accepted but comes with a caveat — a Win-key combination
   * the OS may swallow, an Alt+letter the window menu may claim. Kept apart
   * from the conflict signals because it does not block the save: refusing
   * these outright would forbid chords that work fine on plenty of machines.
   */
  const [agentWarning, setAgentWarning] = createSignal<string | null>(null)
  const [transcriptionWarning, setTranscriptionWarning] = createSignal<
    string | null
  >(null)
  /*
   * The modifiers held down so far, while the chord is still incomplete.
   *
   * Without this the recorder showed its "press keys" prompt and then nothing at all
   * until a full chord landed, so holding Ctrl+Shift and hesitating looked
   * exactly like a recorder that had stopped listening.
   */
  const [pendingModifiers, setPendingModifiers] = createSignal<readonly string[]>([])

  // Local input states for API key, language filter and command trial
  const [apiKeyInput, setApiKeyInput] = createSignal("")
  const [apiKeyVisible, setApiKeyVisible] = createSignal(false)
  const [languageFilter, setLanguageFilter] = createSignal("")
  const [commandFilter, setCommandFilter] = createSignal("")
  const [trialText, setTrialText] = createSignal("")
  const [trialBusy, setTrialBusy] = createSignal(false)
  const [trialNote, setTrialNote] = createSignal<string | undefined>(undefined)
  const [resetArmed, setResetArmed] = createSignal(false)
  const [activeSection, setActiveSection] = createSignal(SECTIONS[0].id)

  /*
   * The machine's audio hardware, and what is cached of the local model.
   *
   * Both are asked for on mount rather than computed: one is a browser API and
   * the other is IndexedDB, and neither is reactive. The device list is asked
   * for again on `devicechange`, because hardware is hot-pluggable and a list
   * enumerated once at open shows the old headset until the panel is closed.
   */
  const [devices, setDevices] = createSignal<AudioDevices>({
    inputs: [SYSTEM_DEFAULT],
    outputs: [SYSTEM_DEFAULT],
    labelled: false,
  })
  const [cached, setCached] = createSignal<CachedModel>(EMPTY_CACHE)
  /* Whether the answer above has been asked for yet. "Not yet known" and
     "nothing downloaded" look the same in `CachedModel` and must not read the
     same in the engine list. */
  const [inspected, setInspected] = createSignal(false)
  const [clearingCache, setClearingCache] = createSignal(false)
  const [downloading, setDownloading] = createSignal(false)
  const [downloadProgress, setDownloadProgress] = createSignal<DownloadParakeetProgress | null>(null)
  const [downloadError, setDownloadError] = createSignal<string | null>(null)
  const [downloadSuccess, setDownloadSuccess] = createSignal(false)

  const refreshDevices = () => {
    void listAudioDevices().then(setDevices)
  }
  const refreshCache = () => {
    void inspectModelCache().then((found) => {
      setCached(found)
      setInspected(true)
    })
  }

  onMount(() => {
    refreshDevices()
    refreshCache()
    const stop = onDeviceChange(refreshDevices)
    onCleanup(stop)
  })

  // Backend readiness diagnostics from select.ts
  const backendStatuses = createMemo(() => {
    return describeBackends({
      apiKey: props.settings.openRouterApiKey,
      /*
       * The answer `describeParakeetReadiness` has always accepted and that
       * nothing outside the tests ever supplied: without it the local engine
       * was reported as usable whether or not a byte of it had been
       * downloaded, so the one hint that choosing it means a long wait was
       * never shown. Undefined until the cache has been inspected, which is
       * also correct — "not yet known" is not "not downloaded".
       */
      isModelDownloaded: inspected() ? cached().present : undefined,
    })
  })

  const hasWebGpu = createMemo(() => isWebGpuAvailable())
  const hasWasm = createMemo(() => isWasmAvailable())

  // Available languages dynamically queried from languages.ts
  const currentLanguages = createMemo<LanguageOption[]>(() => {
    return availableLanguages(props.settings.backend)
  })

  /**
   * The language list narrowed by what has been typed.
   *
   * The selected language is always kept in the list even when it does not
   * match: dropping it would leave the select with no option to show and it
   * would silently display the wrong language.
   */
  const filteredLanguages = createMemo<LanguageOption[]>(() => {
    const query = languageFilter().trim().toLowerCase()
    if (query.length === 0) return currentLanguages()
    return currentLanguages().filter(
      (lang) =>
        lang.code === props.settings.language ||
        lang.code.toLowerCase().includes(query) ||
        lang.label.toLowerCase().includes(query),
    )
  })

  // Check language support for current backend
  const isLangSupported = createMemo(() => {
    return isLanguageSupported(props.settings.backend, props.settings.language)
  })

  // Nearest language recommendation when unsupported
  const langSuggestion = createMemo(() => {
    if (isLangSupported()) return undefined
    return suggestClosestLanguage(props.settings.language, currentLanguages())
  })

  const filteredCommands = createMemo(() => {
    const query = commandFilter().trim().toLowerCase()
    if (query.length === 0) return VOCABULARY
    return VOCABULARY.filter(
      (spec) =>
        spec.intent.toLowerCase().includes(query) ||
        spec.readback.toLowerCase().includes(query) ||
        spec.phrases.some((phrase) => phrase.toLowerCase().includes(query)),
    )
  })

  // Live engine readouts
  const engineRunning = () => props.engine.isRunning()
  const engineStatus = createMemo(() => describeStatus(props.engine.status(), engineRunning()))
  const micLevel = () => props.engine.micLevel()

  const liveLine = createMemo(() => {
    const partial = props.engine.partialTranscript().trim()
    if (partial.length > 0) return { text: partial, kind: "partial" as const }
    const spoken = props.engine.lastSpoken().trim()
    if (engineRunning() && spoken.length > 0) return { text: spoken, kind: "spoken" as const }
    return { text: engineStatus().detail, kind: "hint" as const }
  })

  // Resolve Parakeet download progress from props, direct download, or engine
  const resolvedProgress = createMemo<ParakeetProgress | undefined>(() => {
    if (downloadProgress()) return downloadProgress()!
    if (props.parakeetProgress) return props.parakeetProgress
    const eng = props.engine as unknown as Record<string, unknown>
    if (typeof eng.parakeetProgress === "function") {
      const res = (eng.parakeetProgress as () => unknown)()
      if (res && typeof res === "object") return res as ParakeetProgress
    }
    if (eng.parakeetProgress && typeof eng.parakeetProgress === "object") {
      return eng.parakeetProgress as ParakeetProgress
    }
    return undefined
  })

  // Resolve last request cost from props or engine
  const resolvedCost = createMemo<number | undefined>(() => {
    if (typeof props.lastCost === "number") return props.lastCost
    const eng = props.engine as unknown as Record<string, unknown>
    if (typeof eng.lastCost === "function") {
      const res = (eng.lastCost as () => unknown)()
      if (typeof res === "number") return res
    }
    if (typeof eng.lastCost === "number") return eng.lastCost
    if (typeof eng.lastUsage === "function") {
      const usage = (eng.lastUsage as () => unknown)() as
        | { cost?: number }
        | null
        | undefined
      if (typeof usage?.cost === "number") return usage.cost
    }
    return undefined
  })

  // Upward change dispatcher
  const updateSettings = (patch: Partial<VoiceSettings>) => {
    props.onChange({
      ...props.settings,
      ...patch,
    })
  }

  const startDirectDownload = async () => {
    if (downloading()) return
    setDownloading(true)
    setDownloadError(null)
    setDownloadSuccess(false)
    setDownloadProgress({
      loaded: 0,
      total: 670_488_135,
      percent: 0,
      message: t("vui.download.starting"),
    })
    try {
      const result = await downloadParakeetModel({
        onProgress: (p) => {
          setDownloadProgress(p)
        },
      })
      setCached(result)
      setInspected(true)
      updateSettings({ backend: "parakeet" })
      void warmupParakeetModel({
        executionBackend: props.settings.parakeetBackend,
        language: props.settings.language,
      }).catch(() => {})
      setDownloadSuccess(true)
      setTimeout(() => setDownloadSuccess(false), 6000)
    } catch (err: any) {
      setDownloadError(
        err?.message || t("vui.download.failed")
      )
    } finally {
      setDownloading(false)
    }
  }

  /**
   * Wake-word activation only exists for the agent, so a stored pairing of
   * transcription mode with wake-word activation leaves every activation radio
   * unchecked. Repair it once on open rather than rendering an impossible state.
   */
  onMount(() => {
    if (
      props.settings.mode === "transcription" &&
      props.settings.activation === "wake-word"
    ) {
      updateSettings({ activation: DEFAULT_VOICE_SETTINGS.activation })
    }
    if (!props.inline && panelRef) {
      panelRef.focus()
    }
  })

  const selectMode = (mode: VoiceMode) => {
    if (mode === "transcription" && props.settings.activation === "wake-word") {
      updateSettings({ mode, activation: DEFAULT_VOICE_SETTINGS.activation })
      return
    }
    updateSettings({ mode })
  }

  const selectActivation = (activation: VoiceActivation) => {
    if (activation !== "wake-word" && !shortcutActivationEnabled()) return
    if (activation !== "push-to-talk" && !wakeWordEnabled()) return
    if (activation === "wake-word" && (!wakeWordEnabled() || props.settings.mode !== "agent")) return
    updateSettings({ activation })
  }

  const commitApiKey = () => {
    const trimmed = apiKeyInput().trim()
    if (trimmed.length === 0) return
    updateSettings({ openRouterApiKey: trimmed })
    setApiKeyInput("")
    setApiKeyVisible(false)
  }

  const apiKeyLooksWrong = createMemo(() => {
    const value = apiKeyInput().trim()
    return value.length > 0 && !value.startsWith("sk-or-")
  })

  const toggleListening = () => {
    void props.engine.toggle()
  }

  /**
   * Runs a typed command through the same path a spoken one takes.
   *
   * The engine only accepts text once its program is up, so an idle engine is
   * started first. A start that fails leaves `lastError` set, and the live line
   * is already showing it — no second error channel is needed here.
   */
  const runTrial = async () => {
    const text = trialText().trim()
    if (text.length === 0 || trialBusy()) return
    setTrialBusy(true)
    setTrialNote(undefined)
    try {
      if (!props.engine.isRunning()) {
        await props.engine.start()
      }
      if (!props.engine.isRunning()) {
        setTrialNote(t("vui.trial.noEngine"))
        return
      }
      await props.engine.submitText(text)
      setTrialText("")
    } finally {
      setTrialBusy(false)
    }
  }

  const restoreDefaults = () => {
    if (!resetArmed()) {
      setResetArmed(true)
      return
    }
    setResetArmed(false)
    setApiKeyInput("")
    setApiKeyVisible(false)
    setLanguageFilter("")
    props.onChange({ ...DEFAULT_VOICE_SETTINGS })
  }

  // Global keyboard listener for modal Escape and shortcut recording cancellation
  const handleGlobalKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      if (recordingField() !== null) {
        e.preventDefault()
        e.stopPropagation()
        setRecordingField(null)
        setPendingModifiers([])
        setAgentConflict(null)
        setTranscriptionConflict(null)
        return
      }

      if (resetArmed()) {
        e.preventDefault()
        setResetArmed(false)
        return
      }

      if (!props.inline && props.onClose) {
        e.preventDefault()
        props.onClose()
      }
    }

    // Modal focus trap when rendered as overlay
    if (!props.inline && e.key === "Tab" && panelRef) {
      const focusable = Array.from(
        panelRef.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((el) => el.offsetParent !== null || el === document.activeElement)
      if (focusable.length > 0) {
        const first = focusable[0]
        const last = focusable[focusable.length - 1]
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault()
          last.focus()
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault()
          first.focus()
        }
      }
    }
  }

  createEffect(() => {
    if (typeof window !== "undefined") {
      window.addEventListener("keydown", handleGlobalKeyDown)
      onCleanup(() => window.removeEventListener("keydown", handleGlobalKeyDown))
    }
  })

  /**
   * Opens a section from the rail.
   *
   * There is no scrolling to do any more, so this only swaps which section is
   * shown — but the heading still takes focus. Without that the caret would
   * stay on the rail button while the whole page beside it changed, which for
   * anyone reading by screen reader is a change with no announcement, and for
   * anyone tabbing is a jump backwards through the panel.
   */
  const goToSection = (id: string) => {
    setActiveSection(id)
    queueMicrotask(() => {
      const heading = document
        .getElementById(id)
        ?.querySelector<HTMLElement>('[data-slot="section-title"]')
      heading?.focus()
    })
  }

  const setFieldConflict = (field: "agent" | "transcription", message: string | null) => {
    if (field === "agent") setAgentConflict(message)
    else setTranscriptionConflict(message)
  }

  const setFieldWarning = (field: "agent" | "transcription", message: string | null) => {
    if (field === "agent") setAgentWarning(message)
    else setTranscriptionWarning(message)
  }

  // Key event handler for shortcut capture fields
  const handleShortcutKeyDown = (
    field: "agent" | "transcription",
    e: KeyboardEvent
  ) => {
    e.preventDefault()
    e.stopPropagation()

    const result = captureKeyboardEvent(
      {
        key: e.key,
        ctrlKey: e.ctrlKey,
        metaKey: e.metaKey,
        shiftKey: e.shiftKey,
        altKey: e.altKey,
      },
      platform
    )

    if (result.type === "cancel") {
      setRecordingField(null)
      setPendingModifiers([])
      setFieldConflict(field, null)
      return
    }

    // Not a chord yet: show what is being held rather than nothing.
    if (result.type === "modifier_only") {
      setPendingModifiers(result.modifiers)
      return
    }

    if (result.type === "ignored") {
      return
    }

    const targetCommand =
      field === "agent" ? VOICE_COMMAND_AGENT : VOICE_COMMAND_TRANSCRIPTION

    const conflict = checkShortcutConflict(
      result.chord,
      targetCommand,
      props.settings,
      props.existingBindings,
      platform
    )

    if (conflict.hasConflict) {
      // The recorder stays open so the next attempt needs no second click.
      setPendingModifiers([])
      setFieldConflict(field, conflict.message ?? t("vui.shortcut.conflicting"))
      return
    }

    // Successful capture without collision
    setFieldConflict(field, null)
    setFieldWarning(field, conflict.warning ?? null)
    updateSettings(
      field === "agent"
        ? { agentChord: result.chord }
        : { transcriptionChord: result.chord },
    )
    setRecordingField(null)
    setPendingModifiers([])
  }

  const startRecording = (field: "agent" | "transcription") => {
    setRecordingField(field)
    setPendingModifiers([])
    setFieldConflict(field, null)
    setFieldWarning(field, null)
  }

  const stopRecording = (field: "agent" | "transcription") => {
    if (recordingField() === field) {
      setRecordingField(null)
      setPendingModifiers([])
    }
  }

  const resetChord = (field: "agent" | "transcription") => {
    setFieldConflict(field, null)
    setFieldWarning(field, null)
    updateSettings(
      field === "agent"
        ? { agentChord: DEFAULT_VOICE_SETTINGS.agentChord }
        : { transcriptionChord: DEFAULT_VOICE_SETTINGS.transcriptionChord },
    )
  }

  /**
   * A standing complaint about the chord that is already saved.
   *
   * The recorder refuses a colliding chord, so nothing recorded here can be
   * shadowed — but a profile hand-edited, copied between machines, or written
   * before ADE claimed that chord can hold one anyway, and at runtime ADE wins
   * and the microphone simply never opens. Recomputed from props so it clears
   * itself the moment the chord is changed.
   */
  const storedIssue = (field: "agent" | "transcription") => {
    const chord =
      field === "agent" ? props.settings.agentChord : props.settings.transcriptionChord
    const target =
      field === "agent" ? VOICE_COMMAND_AGENT : VOICE_COMMAND_TRANSCRIPTION
    const verdict = checkShortcutConflict(
      chord,
      target,
      props.settings,
      props.existingBindings,
      platform,
    )
    if (!verdict.hasConflict) return undefined
    return t("vui.shortcut.shadowed", verdict.message ?? t("vui.shortcut.conflicting"))
  }

  /** The recording attempt's complaint, or the saved chord's, in that order. */
  const shortcutIssue = (field: "agent" | "transcription") =>
    (field === "agent" ? agentConflict() : transcriptionConflict()) ?? storedIssue(field)

  /**
   * What the recorder button says while it is listening.
   *
   * The mac glyphs already read as one cluster (⇧⌘), so they are joined with
   * nothing; elsewhere the names need the separator to be legible.
   */
  const recordingLabel = () => {
    const held = pendingModifiers()
    if (held.length === 0) return t("vui.shortcut.recording")
    return `${held.join(platform === "mac" ? "" : "+")}…`
  }

  const handleBackdropClick = (e: MouseEvent) => {
    if (e.target === e.currentTarget && props.onClose) {
      props.onClose()
    }
  }

  const modeKeys = radioGroupKeys((value) => selectMode(value as VoiceMode))
  const sendKeys = radioGroupKeys((value) =>
    updateSettings({ transcriptionSend: value as TranscriptionSendMode }),
  )
  const listenKeys = radioGroupKeys((value) => updateSettings({ alwaysListen: value === "always" }))
  const replyKeys = radioGroupKeys((value) => updateSettings({ speakReplies: value === "speak" }))
  const replyVoiceKeys = radioGroupKeys((value) => updateSettings({ replyVoice: value as ReplyVoice }))
  const engineKeys = radioGroupKeys((value) => updateSettings({ agentEngine: value as AgentEngine }))
  const speedKeys = radioGroupKeys((value) => updateSettings({ agentSpeed: value as AgentSpeed }))
  const activationKeys = radioGroupKeys((value) =>
    selectActivation(value as VoiceActivation),
  )
  const backendKeys = radioGroupKeys((value) => {
    if (value === "parakeet" && !backendStatuses().parakeet.usable) return
    updateSettings({ backend: value as TranscriberBackend })
  })

  const parakeetPill = (value: ParakeetExecutionBackend, label: string, enabled: boolean, hint: string) => (
    <button
      type="button"
      role="radio"
      aria-checked={props.settings.parakeetBackend === value}
      aria-disabled={enabled ? undefined : "true"}
      disabled={!enabled}
      title={hint}
      data-slot="pill-btn"
      onClick={() => {
        if (enabled) updateSettings({ parakeetBackend: value })
      }}
    >
      {label}
    </button>
  )

  // Render main panel contents
  const renderPanel = () => (
    <div
      ref={panelRef}
      data-component="voice-settings-panel"
      data-inline={props.inline ? "true" : undefined}
      data-status={engineStatus().tone}
      class={props.class}
      role={props.inline ? "region" : "dialog"}
      aria-modal={props.inline ? undefined : "true"}
      aria-labelledby="voice-panel-title"
      tabIndex={props.inline ? undefined : -1}
      onClick={(e) => e.stopPropagation()}
    >
      {/* Header */}
      <div data-slot="header">
        <div data-slot="header-mark" aria-hidden="true">
          <span
            data-slot="header-aura"
            style={{
              transform: `scale(${1 + Math.min(micLevel() * 1.6, 0.55)})`,
              opacity: `${engineRunning() ? Math.min(0.25 + micLevel() * 1.5, 0.9) : 0}`,
            }}
          />
          <NikMic size={18} variant="line" />
        </div>

        <div data-slot="header-info">
          {/* Named by the host when the host has put more than voice in it:
              a panel that says "vocale" while showing the plugin list is
              telling the user they are in the wrong place. */}
          <h2 id="voice-panel-title" data-slot="title">
            {props.title ?? t("vui.panel.title")}
          </h2>
          {/* The same reasoning as the title, for the line under it: it used
              to list the voice sections, which with six of the host's own
              beside them described a third of the panel. */}
          <p data-slot="subtitle">
            {props.subtitle ?? t("vui.panel.subtitle")}
          </p>
        </div>

        <div data-slot="status-pill" data-tone={engineStatus().tone} role="status">
          <span data-slot="status-dot" aria-hidden="true" />
          {engineStatus().label}
        </div>

        <Show when={!props.inline && props.onClose}>
          <button
            type="button"
            data-slot="close-btn"
            aria-label={t("vui.panel.close")}
            onClick={props.onClose}
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </Show>
      </div>

      {/*
        Rail and page, side by side.

        One section is on screen at a time, at the full width of the panel.
        What it replaced was a single scroller holding all six, which meant the
        panel was as tall as its longest section plus the other five — taller
        than the window it opened in — and reaching the engine list cost about
        three screens of scrolling.
      */}
      <div data-slot="shell">
        <nav data-slot="rail" aria-label={t("vui.panel.sections")}>
          {/*
            A heading above each run of rows, when the host asks for one.
            This panel began as the voice panel and its six screens were the
            whole list; once the host started adding its own, an unbroken
            column of thirteen rows gave no clue which of them were about the
            microphone. The headings are the only thing that says so.
          */}
          <Show when={props.builtInGroup}>
            {(label) => <span data-slot="rail-group">{label()}</span>}
          </Show>
          <For each={SECTIONS}>
            {(section) => (
              <button
                type="button"
                data-slot="rail-row"
                data-current={activeSection() === section.id ? "true" : undefined}
                aria-current={activeSection() === section.id ? "page" : undefined}
                onClick={() => goToSection(section.id)}
              >
                <span data-slot="rail-glyph" aria-hidden="true">{section.glyph}</span>
                <span data-slot="rail-label">{section.label}</span>
                {/* The current value, so the rail is a summary and not just a
                    menu: most visits here are to check a setting, not change one. */}
                <span data-slot="rail-value">{section.value(props.settings)}</span>
              </button>
            )}
          </For>

          {/* The host's screens, in the same list and drawn the same way. */}
          <Show when={(props.extraSections?.length ?? 0) > 0 && props.extraGroup}>
            {(label) => <span data-slot="rail-group">{label()}</span>}
          </Show>
          <For each={props.extraSections ?? []}>
            {(section) => (
              <button
                type="button"
                data-slot="rail-row"
                data-current={activeSection() === section.id ? "true" : undefined}
                aria-current={activeSection() === section.id ? "page" : undefined}
                onClick={() => goToSection(section.id)}
              >
                <span data-slot="rail-glyph" aria-hidden="true">{section.glyph}</span>
                <span data-slot="rail-label">{section.label}</span>
                <Show when={section.value}>
                  {(value) => <span data-slot="rail-value">{value()}</span>}
                </Show>
              </button>
            )}
          </For>

          <span data-slot="rail-sep" aria-hidden="true" />

          {/* Down here rather than beside "Fatto": a button that throws every
              setting away must not sit a few pixels from the one that keeps them. */}
          <button
            type="button"
            data-slot="rail-row"
            data-tone="quiet"
            data-armed={resetArmed() ? "true" : undefined}
            onClick={restoreDefaults}
            onBlur={() => setResetArmed(false)}
          >
            <span data-slot="rail-glyph" aria-hidden="true">↺</span>
            <span data-slot="rail-label">
              {resetArmed() ? "Confermi?" : "Ripristina"}
            </span>
          </button>
        </nav>

        {/* Body */}
        <div data-slot="body" ref={bodyRef}>
        {/* The host's screens first in source order, hidden like the rest:
            `data-hidden` takes them out of the accessibility tree and the tab
            order too, so only the open one is reachable. */}
        <For each={props.extraSections ?? []}>
          {(section) => (
            <section
              id={section.id}
              data-slot="section"
              data-hidden={activeSection() === section.id ? undefined : "true"}
              aria-label={section.label}
            >
              {section.render()}
            </section>
          )}
        </For>

        {/* ── 1. Mode ────────────────────────────────────────────────── */}
        <section
          id="voice-sec-mode"
          data-slot="section"
          data-hidden={activeSection() === "voice-sec-mode" ? undefined : "true"}
          aria-labelledby="section-mode-title"
        >
          <div data-slot="section-head">
            <h3 id="section-mode-title" data-slot="section-title" tabIndex={-1}>
              {t("vui.mode.title")}
            </h3>
            {/*
              Not a switch between two features — both sono sempre disponibili,
              ognuna col suo tasto. Questa scelta dice solo cosa succede quando
              il microfono viene aperto senza specificare quale delle due.
            */}
            <p data-slot="section-desc">
              {t("vui.mode.desc")}
            </p>
          </div>

          <div
            role="radiogroup"
            aria-labelledby="section-mode-title"
            data-slot="mode-grid"
            onKeyDown={modeKeys}
          >
            {/* Agent Mode */}
            <div
              role="radio"
              data-value="agent"
              aria-checked={props.settings.mode === "agent"}
              tabIndex={props.settings.mode === "agent" ? 0 : -1}
              data-slot="mode-card"
              onClick={() => selectMode("agent")}
            >
              <div data-slot="mode-card-header">
                <span data-slot="mode-card-icon" aria-hidden="true">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
                    <path d="m5 12 4 4 10-10" />
                  </svg>
                </span>
                <span data-slot="mode-card-title">{t("vui.mode.agent")}</span>
                <Show when={props.settings.mode === "agent"}>
                  <span data-slot="mode-card-badge">{t("vui.mode.active")}</span>
                </Show>
              </div>
              <div data-slot="mode-card-desc">{t("vui.mode.agent.desc")}</div>
              <div data-slot="mode-card-chord">
                {describeShortcut(props.settings.agentChord, platform)}
              </div>
            </div>

            {/* Transcription Mode */}
            <div
              role="radio"
              data-value="transcription"
              aria-checked={props.settings.mode === "transcription"}
              tabIndex={props.settings.mode === "transcription" ? 0 : -1}
              data-slot="mode-card"
              onClick={() => selectMode("transcription")}
            >
              <div data-slot="mode-card-header">
                <span data-slot="mode-card-icon" aria-hidden="true">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M4 7h16M4 12h11M4 17h7" />
                  </svg>
                </span>
                <span data-slot="mode-card-title">{t("vui.mode.transcription")}</span>
                <Show when={props.settings.mode === "transcription"}>
                  <span data-slot="mode-card-badge">{t("vui.mode.active")}</span>
                </Show>
              </div>
              <div data-slot="mode-card-desc">
                {t("vui.mode.transcription.desc")}
              </div>
              <div data-slot="mode-card-chord">
                {describeShortcut(props.settings.transcriptionChord, platform)}
              </div>
            </div>
          </div>

          {/*
            Sub-choice under agent mode.

            It lives here rather than in a general "audio" section because it
            is the other half of what agent mode *is*: you say something, the
            session answers. Without it the assistant confirms the send and
            goes quiet, and the answer waits on a screen the user may have
            turned away from.
          */}
          <Show when={props.settings.mode === "agent"}>
            <div data-slot="sub-choice-box">
              <span id="agent-reply-label" data-slot="sub-choice-label">
                {t("vui.replies.title")}
              </span>
              <div
                role="radiogroup"
                aria-labelledby="agent-reply-label"
                data-slot="sub-choice-row"
                onKeyDown={replyKeys}
              >
                <div
                  role="radio"
                  data-value="speak"
                  aria-checked={props.settings.speakReplies !== false}
                  tabIndex={props.settings.speakReplies !== false ? 0 : -1}
                  data-slot="sub-choice-item"
                  onClick={() => updateSettings({ speakReplies: true })}
                >
                  <span data-slot="sub-item-title">{t("vui.replies.speak")}</span>
                  <span data-slot="sub-item-desc">{t("vui.replies.speak.desc")}</span>
                </div>

                <div
                  role="radio"
                  data-value="silent"
                  aria-checked={props.settings.speakReplies === false}
                  tabIndex={props.settings.speakReplies === false ? 0 : -1}
                  data-slot="sub-choice-item"
                  onClick={() => updateSettings({ speakReplies: false })}
                >
                  <span data-slot="sub-item-title">{t("vui.replies.silent")}</span>
                  <span data-slot="sub-item-desc">{t("vui.replies.silent.desc")}</span>
                </div>
              </div>
            </div>

            <Show when={props.settings.speakReplies !== false}>
              <div data-slot="sub-choice-box">
                <span id="reply-voice-label" data-slot="sub-choice-label">
                  {t("vui.replies.voice")}
                </span>
                <div
                  role="radiogroup"
                  aria-labelledby="reply-voice-label"
                  data-slot="sub-choice-row"
                  onKeyDown={replyVoiceKeys}
                >
                  <For each={REPLY_VOICE_CHOICES}>
                    {(choice) => (
                      <div
                        role="radio"
                        data-value={choice.value}
                        aria-checked={props.settings.replyVoice === choice.value}
                        tabIndex={props.settings.replyVoice === choice.value ? 0 : -1}
                        data-slot="sub-choice-item"
                        onClick={() => updateSettings({ replyVoice: choice.value })}
                      >
                        <span data-slot="sub-item-title">{choice.title}</span>
                        <span data-slot="sub-item-desc">{choice.desc}</span>
                        <Show when={choice.licence}>
                          <span data-slot="sub-item-licence">
                            {choice.licence}{" "}
                            <Show when={props.onOpenVoiceSource}>
                              <button
                                type="button"
                                data-slot="link-button"
                                onClick={(event) => {
                                  // The link sits inside the radio: opening the source must not also pick the voice.
                                  event.stopPropagation()
                                  props.onOpenVoiceSource?.(choice.value)
                                }}
                              >
                                {t("vui.replies.source")}
                              </button>
                            </Show>
                          </span>
                        </Show>
                      </div>
                    )}
                  </For>
                </div>
                <p data-slot="sub-choice-note">
                  {t("vui.replies.note")}
                </p>
              </div>
            </Show>

            {/*
              What answers what the grammar does not know. A CLI the user is
              signed in to, so it runs on their subscription; see
              `VoiceSettings.agentEngine`.
            */}
            <div data-slot="sub-choice-box">
              <span id="agent-engine-label" data-slot="sub-choice-label">
                {t("vui.engine.title")}
              </span>
              <div
                role="radiogroup"
                aria-labelledby="agent-engine-label"
                data-slot="sub-choice-row"
                onKeyDown={engineKeys}
              >
                <For each={AGENT_ENGINE_CHOICES}>
                  {(choice) => (
                    <div
                      role="radio"
                      data-value={choice.value}
                      aria-checked={props.settings.agentEngine === choice.value}
                      tabIndex={props.settings.agentEngine === choice.value ? 0 : -1}
                      data-slot="sub-choice-item"
                      onClick={() => updateSettings({ agentEngine: choice.value })}
                    >
                      <span data-slot="sub-item-title">{choice.title}</span>
                      <span data-slot="sub-item-desc">{choice.desc}</span>
                    </div>
                  )}
                </For>
              </div>
              {/*
                S13: the agent runs on the user's own subscription, so the
                terms that come with it are said where the engine is chosen.
              */}
              <p data-slot="sub-choice-note">
                {t("vui.engine.note")}
              </p>
            </div>

            {/* How the agent thinks: see `VoiceSettings.agentSpeed`. */}
            <Show when={props.settings.agentEngine !== "off"}>
              <div data-slot="sub-choice-box">
                <span id="agent-speed-label" data-slot="sub-choice-label">
                  {t("vui.speed.title")}
                </span>
                <div
                  role="radiogroup"
                  aria-labelledby="agent-speed-label"
                  data-slot="sub-choice-row"
                  onKeyDown={speedKeys}
                >
                  <For each={AGENT_SPEED_CHOICES}>
                    {(choice) => (
                      <div
                        role="radio"
                        data-value={choice.value}
                        aria-checked={props.settings.agentSpeed === choice.value}
                        tabIndex={props.settings.agentSpeed === choice.value ? 0 : -1}
                        data-slot="sub-choice-item"
                        onClick={() => updateSettings({ agentSpeed: choice.value })}
                      >
                        <span data-slot="sub-item-title">{choice.title}</span>
                        <span data-slot="sub-item-desc">{choice.desc}</span>
                      </div>
                    )}
                  </For>
                </div>
              </div>
            </Show>
          </Show>

          {/* Sub-choice under transcription */}
          <Show when={props.settings.mode === "transcription"}>
            <div data-slot="sub-choice-box">
              <span id="transcription-send-label" data-slot="sub-choice-label">
                {t("vui.send.title")}
              </span>
              <div
                role="radiogroup"
                aria-labelledby="transcription-send-label"
                data-slot="sub-choice-row"
                onKeyDown={sendKeys}
              >
                <div
                  role="radio"
                  data-value="manual"
                  aria-checked={props.settings.transcriptionSend === "manual"}
                  tabIndex={props.settings.transcriptionSend === "manual" ? 0 : -1}
                  data-slot="sub-choice-item"
                  onClick={() => updateSettings({ transcriptionSend: "manual" })}
                >
                  <span data-slot="sub-item-title">{t("vui.send.manual")}</span>
                  <span data-slot="sub-item-desc">{t("vui.send.manual.desc")}</span>
                </div>

                <div
                  role="radio"
                  data-value="auto"
                  aria-checked={props.settings.transcriptionSend === "auto"}
                  tabIndex={props.settings.transcriptionSend === "auto" ? 0 : -1}
                  data-slot="sub-choice-item"
                  onClick={() => updateSettings({ transcriptionSend: "auto" })}
                >
                  <span data-slot="sub-item-title">{t("vui.send.auto")}</span>
                  <span data-slot="sub-item-desc">
                    {t("vui.send.auto.desc")}
                  </span>
                </div>
              </div>
            </div>
          </Show>
        </section>

        {/* ── 2. Activation ──────────────────────────────────────────── */}
        <section
          id="voice-sec-activation"
          data-slot="section"
          data-hidden={activeSection() === "voice-sec-activation" ? undefined : "true"}
          aria-labelledby="section-activation-title"
        >
          <div data-slot="section-head">
            <h3 id="section-activation-title" data-slot="section-title" tabIndex={-1}>
              {t("vui.activation.title")}
            </h3>
            <p data-slot="section-desc">
              {t("vui.activation.desc")}
            </p>
          </div>

          <div
            role="radiogroup"
            aria-labelledby="section-activation-title"
            data-slot="activation-list"
            onKeyDown={activationKeys}
          >
            {/* Push to talk: behind SHORTCUT_ACTIVATION_ENABLED, off: the name is the only way */}
            <Show when={shortcutActivationEnabled()}>
            <div
              role="radio"
              data-value="push-to-talk"
              aria-checked={props.settings.activation === "push-to-talk"}
              tabIndex={props.settings.activation === "push-to-talk" ? 0 : -1}
              data-slot="activation-item"
              onClick={() => selectActivation("push-to-talk")}
            >
              <div data-slot="item-text-group">
                <span data-slot="item-title">{t("vui.activation.push")}</span>
                <span data-slot="item-desc">{t("vui.activation.push.desc")}</span>
              </div>
              <kbd data-slot="chord-chip">
                {describeShortcut(
                  props.settings.mode === "transcription"
                    ? props.settings.transcriptionChord
                    : props.settings.agentChord,
                  platform,
                )}
              </kbd>
            </div>
            </Show>

            {/* Toggle continuous: behind both switches, off */}
            <Show when={wakeWordEnabled() && shortcutActivationEnabled()}>
            <div
              role="radio"
              data-value="toggle"
              aria-checked={props.settings.activation === "toggle"}
              tabIndex={props.settings.activation === "toggle" ? 0 : -1}
              data-slot="activation-item"
              onClick={() => selectActivation("toggle")}
            >
              <div data-slot="item-text-group">
                <span data-slot="item-title">{t("vui.activation.toggle")}</span>
                <span data-slot="item-desc">{t("vui.activation.toggle.desc")}</span>
              </div>
              <kbd data-slot="chord-chip">
                {describeShortcut(
                  props.settings.mode === "transcription"
                    ? props.settings.transcriptionChord
                    : props.settings.agentChord,
                  platform,
                )}
              </kbd>
            </div>
            </Show>

            <Show when={props.settingsNotice}>
              {(text) => (
                // Informational, not a failure: nothing went wrong, a default changed.
                <div data-slot="reason-box" data-tone="muted" role="status">
                  {text()}
                </div>
              )}
            </Show>
            {/* Wake Word: behind WAKE_WORD_ENABLED, off in 0.7.0 */}
            <Show when={wakeWordEnabled()}>
            <div data-slot="activation-group">
              <div
                role="radio"
                data-value="wake-word"
                aria-checked={
                  props.settings.mode === "agent" &&
                  props.settings.activation === "wake-word"
                }
                aria-disabled={
                  props.settings.mode === "transcription" ? "true" : undefined
                }
                aria-describedby={
                  props.settings.mode === "transcription"
                    ? "wake-word-disabled-reason"
                    : undefined
                }
                tabIndex={
                  props.settings.mode === "agent" &&
                  props.settings.activation === "wake-word"
                    ? 0
                    : -1
                }
                data-slot="activation-item"
                onClick={() => selectActivation("wake-word")}
              >
                <div data-slot="item-text-group">
                  <span data-slot="item-title">{t("vui.activation.wake")}</span>
                  <span data-slot="item-desc">
                    {t("vui.activation.wake.desc")}
                  </span>
                </div>
                <Show when={props.settings.mode === "agent"}>
                  <kbd data-slot="chord-chip">«{props.settings.wakeWord}»</kbd>
                </Show>
              </div>

              {/* Disabled reason in transcription mode */}
              <Show when={props.settings.mode === "transcription"}>
                <div id="wake-word-disabled-reason" data-slot="reason-box" data-tone="muted">
                  {t("vui.activation.wake.disabled")}
                </div>
              </Show>

              {/* The phrase is fixed; what can be chosen is whether ADE listens by itself. */}
              <Show
                when={
                  props.settings.mode === "agent" &&
                  props.settings.activation === "wake-word"
                }
              >
                <div data-slot="sub-choice-box">
                  <span id="listen-label" data-slot="sub-choice-label">
                    {t("vui.listen.title")}
                  </span>
                  <div
                    role="radiogroup"
                    aria-labelledby="listen-label"
                    aria-describedby="wake-word-hint"
                    data-slot="sub-choice-row"
                    onKeyDown={listenKeys}
                  >
                    <div
                      role="radio"
                      data-value="always"
                      aria-checked={props.settings.alwaysListen !== false}
                      tabIndex={props.settings.alwaysListen !== false ? 0 : -1}
                      data-slot="sub-choice-item"
                      onClick={() => updateSettings({ alwaysListen: true })}
                    >
                      <span data-slot="sub-item-title">{t("vui.listen.always")}</span>
                      <span data-slot="sub-item-desc">
                        {t("vui.listen.always.desc", props.settings.wakeWord)}
                      </span>
                    </div>
                    <div
                      role="radio"
                      data-value="manual"
                      aria-checked={props.settings.alwaysListen === false}
                      tabIndex={props.settings.alwaysListen === false ? 0 : -1}
                      data-slot="sub-choice-item"
                      onClick={() => updateSettings({ alwaysListen: false })}
                    >
                      <span data-slot="sub-item-title">{t("vui.listen.manual")}</span>
                      <span data-slot="sub-item-desc">{t("vui.listen.manual.desc")}</span>
                    </div>
                  </div>
                  <p id="wake-word-hint" data-slot="hint">
                    {t("vui.wake.hint", props.settings.wakeWord)}
                  </p>
                </div>
              </Show>
            </div>
            </Show>
          </div>
        </section>

        {/* ── 3. Shortcuts ───────────────────────────────────────────── */}
        <section
          id="voice-sec-shortcuts"
          data-slot="section"
          data-hidden={activeSection() === "voice-sec-shortcuts" ? undefined : "true"}
          aria-labelledby="section-shortcuts-title"
        >
          <div data-slot="section-head">
            <h3 id="section-shortcuts-title" data-slot="section-title" tabIndex={-1}>
              {t("vui.shortcuts.title")}
            </h3>
            <p data-slot="section-desc">
              {t("vui.shortcuts.desc")}
            </p>
          </div>

          <div data-slot="shortcuts-list">
            {/* Agent Shortcut */}
            <div>
              <div data-slot="shortcut-row">
                <div data-slot="item-text-group">
                  <label for="agent-chord-btn" data-slot="item-title">
                    {t("vui.shortcuts.agent")}
                  </label>
                  <span id="agent-chord-desc" data-slot="item-desc">
                    {t("vui.shortcuts.agent.desc")}
                  </span>
                </div>
                <div data-slot="shortcut-controls">
                  <button
                    id="agent-chord-btn"
                    type="button"
                    data-slot="shortcut-recorder-btn"
                    data-recording={recordingField() === "agent" ? "true" : undefined}
                    aria-describedby="agent-chord-desc"
                    onClick={() => startRecording("agent")}
                    onBlur={() => stopRecording("agent")}
                    onKeyDown={(e) => {
                      if (recordingField() === "agent") {
                        handleShortcutKeyDown("agent", e)
                      }
                    }}
                  >
                    {recordingField() === "agent"
                      ? recordingLabel()
                      : describeShortcut(props.settings.agentChord, platform)}
                  </button>
                  <button
                    type="button"
                    data-slot="ghost-btn"
                    aria-label={t("vui.shortcuts.agent.reset")}
                    disabled={props.settings.agentChord === DEFAULT_VOICE_SETTINGS.agentChord}
                    onClick={() => resetChord("agent")}
                  >
                    {t("vui.shortcuts.reset")}
                  </button>
                </div>
              </div>
              <Show when={shortcutIssue("agent")}>
                {(issue) => (
                  <div role="alert" data-slot="reason-box">
                    {issue()}
                  </div>
                )}
              </Show>
              <Show when={agentWarning()}>
                {(warning) => (
                  <div role="status" data-slot="reason-box" data-tone="muted">
                    {t("vui.shortcuts.saved", warning())}
                  </div>
                )}
              </Show>
            </div>

            {/* Transcription Shortcut */}
            <div>
              <div data-slot="shortcut-row">
                <div data-slot="item-text-group">
                  <label for="transcription-chord-btn" data-slot="item-title">
                    {t("vui.shortcuts.transcription")}
                  </label>
                  <span id="transcription-chord-desc" data-slot="item-desc">
                    {t("vui.shortcuts.transcription.desc")}
                  </span>
                </div>
                <div data-slot="shortcut-controls">
                  <button
                    id="transcription-chord-btn"
                    type="button"
                    data-slot="shortcut-recorder-btn"
                    data-recording={
                      recordingField() === "transcription" ? "true" : undefined
                    }
                    aria-describedby="transcription-chord-desc"
                    onClick={() => startRecording("transcription")}
                    onBlur={() => stopRecording("transcription")}
                    onKeyDown={(e) => {
                      if (recordingField() === "transcription") {
                        handleShortcutKeyDown("transcription", e)
                      }
                    }}
                  >
                    {recordingField() === "transcription"
                      ? recordingLabel()
                      : describeShortcut(props.settings.transcriptionChord, platform)}
                  </button>
                  <button
                    type="button"
                    data-slot="ghost-btn"
                    aria-label={t("vui.shortcuts.transcription.reset")}
                    disabled={
                      props.settings.transcriptionChord ===
                      DEFAULT_VOICE_SETTINGS.transcriptionChord
                    }
                    onClick={() => resetChord("transcription")}
                  >
                    {t("vui.shortcuts.reset")}
                  </button>
                </div>
              </div>
              <Show when={shortcutIssue("transcription")}>
                {(issue) => (
                  <div role="alert" data-slot="reason-box">
                    {issue()}
                  </div>
                )}
              </Show>
              <Show when={transcriptionWarning()}>
                {(warning) => (
                  <div role="status" data-slot="reason-box" data-tone="muted">
                    {t("vui.shortcuts.saved", warning())}
                  </div>
                )}
              </Show>
            </div>
          </div>
        </section>

        {/* ── 4. Language ───────────────────────────────────────────── */}
        <section
          id="voice-sec-language"
          data-slot="section"
          data-hidden={activeSection() === "voice-sec-language" ? undefined : "true"}
          aria-labelledby="section-language-title"
        >
          <div data-slot="section-head">
            <h3 id="section-language-title" data-slot="section-title" tabIndex={-1}>
              {t("vui.language.title")}
            </h3>
            <p data-slot="section-desc">
              {t("vui.language.desc")}
            </p>
          </div>

          <div data-slot="stack">
            <label for="voice-language-filter" data-slot="label">
              {t("vui.language.search")}
            </label>
            <input
              id="voice-language-filter"
              data-slot="input"
              type="search"
              autocomplete="off"
              placeholder={t("vui.language.search.placeholder")}
              value={languageFilter()}
              aria-describedby="voice-language-count"
              onInput={(e) => setLanguageFilter(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  e.preventDefault()
                  e.stopPropagation()
                  setLanguageFilter("")
                  return
                }
                if (e.key === "Enter") {
                  e.preventDefault()
                  const first = filteredLanguages().find(
                    (lang) => lang.code !== props.settings.language,
                  )
                  if (first) updateSettings({ language: first.code })
                }
              }}
            />

            <label for="voice-language-select" data-slot="label">
              {t("vui.language.select")}
            </label>
            <select
              id="voice-language-select"
              data-slot="select"
              value={props.settings.language}
              onChange={(e) => updateSettings({ language: e.currentTarget.value })}
            >
              <For each={filteredLanguages()}>
                {(lang) => (
                  <option value={lang.code}>
                    {lang.label} ({lang.code.toUpperCase()})
                  </option>
                )}
              </For>
            </select>
            <p id="voice-language-count" data-slot="hint">
              {t("vui.language.count", filteredLanguages().length, currentLanguages().length, props.settings.backend)}
            </p>
          </div>

          {/* Unsupported language alert and closest language recommendation */}
          <Show when={!isLangSupported()}>
            <div role="alert" data-slot="lang-warning">
              <div data-slot="lang-warning-msg">
                {t("vui.language.unsupported", props.settings.language, props.settings.backend)}
              </div>
              <Show when={langSuggestion()}>
                <button
                  type="button"
                  data-slot="lang-suggest-btn"
                  onClick={() =>
                    updateSettings({ language: langSuggestion()!.code })
                  }
                >
                  {t("vui.language.switch", `${langSuggestion()?.label} (${langSuggestion()?.code.toUpperCase()})`)}
                </button>
              </Show>
            </div>
          </Show>
        </section>

        {/* ── 5. Audio ───────────────────────────────────────────────── */}
        <section
          id="voice-sec-devices"
          data-slot="section"
          data-hidden={activeSection() === "voice-sec-devices" ? undefined : "true"}
          aria-labelledby="section-devices-title"
        >
          <div data-slot="section-head">
            <h3 id="section-devices-title" data-slot="section-title" tabIndex={-1}>
              {t("vui.audio.title")}
            </h3>
            <p data-slot="section-desc">
              {t("vui.audio.desc")}
            </p>
          </div>

          <div data-slot="stack">
            <label for="voice-input-device" data-slot="label">
              {t("vui.audio.mic")}
            </label>
            <select
              id="voice-input-device"
              data-slot="select"
              value={props.settings.inputDeviceId ?? ""}
              onChange={(e) => updateSettings({ inputDeviceId: e.currentTarget.value || undefined })}
            >
              <For each={devices().inputs}>
                {(device) => <option value={device.id}>{device.label}</option>}
              </For>
            </select>
            <p data-slot="hint">
              {/*
                Said, because the alternative is a picker full of "Microfono 1"
                and "Microfono 2" with no way to tell which is which: the
                browser withholds device names until the microphone has been
                granted once, and that is a fact about permission rather than
                about the hardware.
              */}
              <Show
                when={devices().labelled}
                fallback={
                  <>
                    {t("vui.audio.unlabelled")}
                  </>
                }
              >
                {t("vui.audio.current", describeChoice(props.settings.inputDeviceId, devices().inputs))}
              </Show>
            </p>

            <label for="voice-output-device" data-slot="label">
              {t("vui.audio.output")}
            </label>
            <select
              id="voice-output-device"
              data-slot="select"
              value={props.settings.outputDeviceId ?? ""}
              onChange={(e) => updateSettings({ outputDeviceId: e.currentTarget.value || undefined })}
            >
              <For each={devices().outputs}>
                {(device) => <option value={device.id}>{device.label}</option>}
              </For>
            </select>
            <p data-slot="hint">
              {/*
                Honest about a limit rather than quietly ignoring the setting.
                The synthesiser the assistant speaks through has no way to
                choose an output at all — it always goes to the system default
                — so a picker that pretended otherwise would be a control that
                does nothing, which is worse than one that says what it is
                waiting for.
              */}
              {t("vui.audio.output.note")}
            </p>
          </div>

          <div data-slot="stack">
            <span data-slot="label">{t("vui.model.title")}</span>
            <p data-slot="hint">
              <Show
                when={cached().files > 0 || cached().present}
                fallback={<>{t("vui.model.none")}</>}
              >
                {cached().source === "filesystem" ? (
                  <>
                    {t("vui.model.found", (cached().bytes / (1024 * 1024)).toFixed(0), cached().modelFormat?.toUpperCase() || t("vui.model.local"))}
                    {cached().localPath ? (
                      <span style={{ display: "block", "margin-top": "4px", "font-family": "monospace", "font-size": "11px", opacity: "0.8" }}>
                        {t("vui.model.path", cached().localPath ?? "")}
                      </span>
                    ) : null}
                  </>
                ) : (
                  <>{t(cached().present ? "vui.model.cached" : "vui.model.partial", cached().files, (cached().bytes / (1024 * 1024)).toFixed(0))}</>
                )}
              </Show>
            </p>

            <Show when={!cached().present}>
              <Show
                when={downloading()}
                fallback={
                  <div style={{ display: "flex", "align-items": "center", gap: "12px", "flex-wrap": "wrap" }}>
                    <button
                      type="button"
                      data-slot="solid-btn"
                      onClick={startDirectDownload}
                    >
                      {t("vui.model.download")}
                    </button>
                    <span data-slot="hint">{t("vui.model.download.hint")}</span>
                  </div>
                }
              >
                <div data-slot="progress-box">
                  <div data-slot="progress-meta">
                    <span>{downloadProgress()?.message || t("vui.model.downloading")}</span>
                    <span>
                      {((downloadProgress()?.loaded || 0) / (1024 * 1024)).toFixed(1)} MB /{" "}
                      {((downloadProgress()?.total || 670488135) / (1024 * 1024)).toFixed(1)} MB (
                      {downloadProgress()?.percent ?? 0}%)
                    </span>
                  </div>
                  <div
                    role="progressbar"
                    aria-valuenow={downloadProgress()?.percent ?? 0}
                    aria-valuemin="0"
                    aria-valuemax="100"
                    data-slot="progressbar-track"
                  >
                    <div
                      data-slot="progressbar-fill"
                      style={{ width: `${downloadProgress()?.percent ?? 0}%` }}
                    />
                  </div>
                </div>
              </Show>
              <Show when={downloadError()}>
                <div data-slot="reason-box">
                  {downloadError()}
                </div>
              </Show>
            </Show>

            <Show when={downloadSuccess()}>
              <div data-slot="ready-tag" data-ready="true" style={{ "align-self": "flex-start", padding: "6px 12px" }}>
                {t("vui.model.downloaded")}
              </div>
            </Show>
            <Show when={cached().source === "indexeddb" && cached().files > 0}>
              <button
                type="button"
                data-slot="secondary-btn"
                disabled={clearingCache()}
                onClick={() => {
                  setClearingCache(true)
                  void clearModelCache()
                    .then(() => disposeParakeetModel())
                    .finally(() => {
                      setClearingCache(false)
                      refreshCache()
                    })
                }}
              >
                {clearingCache() ? t("vui.model.deleting") : t("vui.model.delete")}
              </button>
              <p data-slot="hint">
                {/* The only cure for a file that arrived truncated: the download
                    returns 200 either way, so a short file is cached and served
                    forever, and nothing else in the application can throw it away. */}
                {t("vui.model.delete.hint")}
              </p>
            </Show>
          </div>
        </section>

        {/* ── 6. Speech engine ───────────────────────────────────────── */}
        <section
          id="voice-sec-backend"
          data-slot="section"
          data-hidden={activeSection() === "voice-sec-backend" ? undefined : "true"}
          aria-labelledby="section-backend-title"
        >
          <div data-slot="section-head">
            <h3 id="section-backend-title" data-slot="section-title" tabIndex={-1}>
              {t("vui.backend.title")}
            </h3>
            <p data-slot="section-desc">
              {t("vui.backend.desc")}
            </p>
          </div>

          <div
            role="radiogroup"
            aria-labelledby="section-backend-title"
            data-slot="backend-list"
            onKeyDown={backendKeys}
          >
            {/* 1. Parakeet Locale */}
            <div
              data-slot="backend-card"
              data-checked={props.settings.backend === "parakeet" ? "true" : undefined}
              data-unusable={!(hasWebGpu() || hasWasm()) ? "true" : undefined}
            >
              <div
                data-slot="backend-header"
                role="radio"
                data-value="parakeet"
                tabIndex={props.settings.backend === "parakeet" ? 0 : -1}
                aria-checked={props.settings.backend === "parakeet"}
                aria-disabled={!(hasWebGpu() || hasWasm()) ? "true" : undefined}
                aria-describedby={
                  !backendStatuses().parakeet.usable && !cached().present
                    ? "backend-parakeet-reason"
                    : undefined
                }
                onClick={() => {
                  if (hasWebGpu() || hasWasm() || backendStatuses().parakeet.usable) {
                    updateSettings({ backend: "parakeet" })
                  }
                }}
              >
                <div data-slot="item-text-group">
                  <span data-slot="item-title">{t("vui.backend.parakeet")}</span>
                  <span data-slot="item-desc">
                    {t("vui.backend.parakeet.desc")}
                  </span>
                </div>
                <span
                  data-slot="ready-tag"
                  data-ready={backendStatuses().parakeet.usable || cached().present ? "true" : "false"}
                >
                  {downloading()
                    ? t("vui.backend.downloading", downloadProgress()?.percent ?? 0)
                    : cached().present
                      ? t("vui.backend.readyLocal")
                      : backendStatuses().parakeet.usable
                        ? t("vui.backend.ready")
                        : (hasWebGpu() || hasWasm() ? t("vui.backend.available") : t("vui.backend.unsupported"))}
                </span>
              </div>

              <p data-slot="backend-warning">
                {t("vui.backend.parakeet.note")}
              </p>

              {/* Direct download when not available locally */}
              <Show when={!cached().present}>
                <Show
                  when={downloading()}
                  fallback={
                    <div style={{ display: "flex", "align-items": "center", gap: "12px", "flex-wrap": "wrap" }}>
                      <button
                        type="button"
                        data-slot="solid-btn"
                        onClick={startDirectDownload}
                      >
                        {t("vui.model.download")}
                      </button>
                      <span data-slot="hint">{t("vui.model.download.hint")}</span>
                    </div>
                  }
                >
                  <div data-slot="progress-box">
                    <div data-slot="progress-meta">
                      <span>{downloadProgress()?.message || t("vui.model.downloading")}</span>
                      <span>
                        {((downloadProgress()?.loaded || 0) / (1024 * 1024)).toFixed(1)} MB /{" "}
                        {((downloadProgress()?.total || 670488135) / (1024 * 1024)).toFixed(1)} MB (
                        {downloadProgress()?.percent ?? 0}%)
                      </span>
                    </div>
                    <div
                      role="progressbar"
                      aria-valuenow={downloadProgress()?.percent ?? 0}
                      aria-valuemin="0"
                      aria-valuemax="100"
                      data-slot="progressbar-track"
                    >
                      <div
                        data-slot="progressbar-fill"
                        style={{ width: `${downloadProgress()?.percent ?? 0}%` }}
                      />
                    </div>
                  </div>
                </Show>
              </Show>

              <Show when={downloadSuccess()}>
                <div data-slot="ready-tag" data-ready="true" style={{ "align-self": "flex-start", padding: "6px 12px" }}>
                  {t("vui.model.downloaded")}
                </div>
              </Show>

              <Show when={downloadError()}>
                <div data-slot="reason-box">
                  {downloadError()}
                </div>
              </Show>

              {/* Parakeet unusable reason */}
              <Show when={!backendStatuses().parakeet.usable && !cached().present && !(hasWebGpu() || hasWasm())}>
                <div id="backend-parakeet-reason" data-slot="reason-box">
                  {backendStatuses().parakeet.reason}
                </div>
              </Show>

              {/* Sub-fields under Parakeet */}
              <Show when={props.settings.backend === "parakeet"}>
                <div data-slot="backend-subfields">
                  <div data-slot="stack">
                    <span id="parakeet-backend-label" data-slot="label">
                      {t("vui.backend.accel")}
                    </span>
                    <div
                      role="radiogroup"
                      aria-labelledby="parakeet-backend-label"
                      data-slot="pills-row"
                    >
                      {parakeetPill(
                        "auto",
                        t("vui.engine.auto"),
                        true,
                        t("vui.backend.accel.auto"),
                      )}
                      {parakeetPill(
                        "webgpu",
                        "WebGPU",
                        hasWebGpu(),
                        hasWebGpu()
                          ? t("vui.backend.accel.gpu")
                          : t("vui.backend.accel.noGpu"),
                      )}
                      {parakeetPill(
                        "wasm",
                        "WASM",
                        hasWasm(),
                        hasWasm()
                          ? t("vui.backend.accel.cpu")
                          : t("vui.backend.accel.noWasm"),
                      )}
                    </div>
                  </div>

                  {/* Neural model download progress */}
                  <Show when={!downloading() && resolvedProgress() && (resolvedProgress()!.total > 0 || resolvedProgress()!.percent !== undefined)}>
                    {(() => {
                      const p = resolvedProgress()!
                      const percent =
                        p.percent ??
                        (p.total > 0 ? Math.round((p.loaded / p.total) * 100) : 0)
                      const loadedMb = (p.loaded / (1024 * 1024)).toFixed(1)
                      const totalMb = (p.total / (1024 * 1024)).toFixed(1)

                      return (
                        <div data-slot="progress-box">
                          <div data-slot="progress-meta">
                            <span>{t("vui.backend.weights", p.message || t("vui.backend.weights.default"))}</span>
                            <span>
                              {loadedMb} MB / {totalMb} MB ({percent}%)
                            </span>
                          </div>
                          <div
                            role="progressbar"
                            aria-valuenow={percent}
                            aria-valuemin="0"
                            aria-valuemax="100"
                            data-slot="progressbar-track"
                          >
                            <div
                              data-slot="progressbar-fill"
                              style={{ width: `${percent}%` }}
                            />
                          </div>
                        </div>
                      )
                    })()}
                  </Show>
                </div>
              </Show>
            </div>

            {/* 2. OpenRouter Cloud */}
            <div
              data-slot="backend-card"
              data-checked={props.settings.backend === "openrouter" ? "true" : undefined}
              data-unusable={!backendStatuses().openrouter.usable ? "true" : undefined}
            >
              <div
                data-slot="backend-header"
                role="radio"
                data-value="openrouter"
                tabIndex={props.settings.backend === "openrouter" ? 0 : -1}
                aria-checked={props.settings.backend === "openrouter"}
                aria-describedby={
                  !backendStatuses().openrouter.usable
                    ? "backend-openrouter-reason"
                    : undefined
                }
                onClick={() => updateSettings({ backend: "openrouter" })}
              >
                <div data-slot="item-text-group">
                  <span data-slot="item-title">OpenRouter</span>
                  <span data-slot="item-desc">
                    {t("vui.backend.openrouter.desc")}
                  </span>
                </div>
                <span
                  data-slot="ready-tag"
                  data-ready={backendStatuses().openrouter.usable ? "true" : "false"}
                >
                  {backendStatuses().openrouter.usable ? t("vui.backend.ready") : t("vui.backend.needsKey")}
                </span>
              </div>

              {/* OpenRouter status message if key missing */}
              <Show when={!backendStatuses().openrouter.usable}>
                <div id="backend-openrouter-reason" data-slot="reason-box" data-tone="muted">
                  {backendStatuses().openrouter.reason}
                </div>
              </Show>

              {/* Sub-fields under OpenRouter */}
              <Show when={props.settings.backend === "openrouter"}>
                <div data-slot="backend-subfields">
                  <div data-slot="stack">
                    <label for="openrouter-key-field" data-slot="label">
                      {t("vui.key.title")}
                    </label>

                    {/* Masked display when key already saved */}
                    <Show when={Boolean(props.settings.openRouterApiKey)}>
                      <div data-slot="key-status-badge">
                        <span>
                          {t("vui.key.saved", formatMaskedApiKey(props.settings.openRouterApiKey))}
                        </span>
                        <button
                          type="button"
                          data-slot="key-clear-btn"
                          onClick={() => updateSettings({ openRouterApiKey: undefined })}
                        >
                          {t("vui.key.remove")}
                        </button>
                      </div>
                    </Show>

                    {/* Input for setting or updating key */}
                    <div data-slot="field-row">
                      <input
                        id="openrouter-key-field"
                        data-slot="input"
                        type={apiKeyVisible() ? "text" : "password"}
                        autocomplete="off"
                        spellcheck={false}
                        placeholder={
                          props.settings.openRouterApiKey
                            ? t("vui.key.replace")
                            : "sk-or-v1-…"
                        }
                        value={apiKeyInput()}
                        aria-describedby="openrouter-key-hint"
                        onInput={(e) => setApiKeyInput(e.currentTarget.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            e.preventDefault()
                            commitApiKey()
                          } else if (e.key === "Escape") {
                            e.preventDefault()
                            e.stopPropagation()
                            setApiKeyInput("")
                          }
                        }}
                        onBlur={commitApiKey}
                      />
                      <button
                        type="button"
                        data-slot="ghost-btn"
                        aria-pressed={apiKeyVisible()}
                        disabled={apiKeyInput().length === 0}
                        onClick={() => setApiKeyVisible((v) => !v)}
                      >
                        {apiKeyVisible() ? t("vui.key.hide") : t("vui.key.show")}
                      </button>
                      <button
                        type="button"
                        data-slot="solid-btn"
                        disabled={apiKeyInput().trim().length === 0}
                        onClick={commitApiKey}
                      >
                        {t("vui.key.save")}
                      </button>
                    </div>

                    <Show when={apiKeyLooksWrong()}>
                      <div data-slot="reason-box" data-tone="muted">
                        {t("vui.key.looksWrong")}
                      </div>
                    </Show>

                    <p id="openrouter-key-hint" data-slot="hint">
                      {t("vui.key.hint")}
                    </p>
                  </div>

                  {/* Cost of the last request if exposed */}
                  <Show when={resolvedCost() !== undefined}>
                    <div data-slot="cost-tag">
                      {t("vui.key.cost")}{" "}
                      <strong>
                        ${resolvedCost()! < 0.01
                          ? resolvedCost()!.toFixed(5)
                          : resolvedCost()!.toFixed(3)}
                      </strong>
                    </div>
                  </Show>
                </div>
              </Show>
            </div>

          </div>
        </section>

        {/* ── 7. Voice commands ──────────────────────────────────────── */}
        <section
          id="voice-sec-commands"
          data-slot="section"
          data-hidden={activeSection() === "voice-sec-commands" ? undefined : "true"}
          aria-labelledby="section-commands-title"
        >
          <div data-slot="section-head">
            <h3 id="section-commands-title" data-slot="section-title" tabIndex={-1}>
              {t("vui.commands.title")}
            </h3>
            <p data-slot="section-desc">
              {t("vui.commands.desc")}
            </p>
          </div>

          <div data-slot="trial-row">
            <input
              id="voice-trial-input"
              data-slot="input"
              type="text"
              autocomplete="off"
              placeholder={t("vui.commands.trial.placeholder")}
              aria-label={t("vui.commands.trial")}
              value={trialText()}
              disabled={trialBusy()}
              onInput={(e) => setTrialText(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault()
                  void runTrial()
                } else if (e.key === "Escape") {
                  e.preventDefault()
                  e.stopPropagation()
                  setTrialText("")
                }
              }}
            />
            <button
              type="button"
              data-slot="solid-btn"
              disabled={trialText().trim().length === 0 || trialBusy()}
              onClick={() => void runTrial()}
            >
              {trialBusy() ? t("vui.commands.sending") : t("vui.commands.run")}
            </button>
          </div>
          <Show when={trialNote()}>
            <div role="alert" data-slot="reason-box">
              {trialNote()}
            </div>
          </Show>

          <input
            id="voice-command-filter"
            data-slot="input"
            type="search"
            autocomplete="off"
            placeholder={t("vui.commands.filter")}
            aria-label={t("vui.commands.filter.label")}
            aria-describedby="voice-command-count"
            value={commandFilter()}
            onInput={(e) => setCommandFilter(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault()
                e.stopPropagation()
                setCommandFilter("")
              }
            }}
          />

          <div data-slot="command-list">
            <For
              each={filteredCommands()}
              fallback={
                <p data-slot="hint">{t("vui.commands.none")}</p>
              }
            >
              {(spec) => (
                <div data-slot="command-row">
                  <div data-slot="command-info">
                    <span data-slot="command-name">
                      {spec.intent}
                      <Show when={spec.destructive}>
                        <span data-slot="command-flag">{t("vui.commands.confirms")}</span>
                      </Show>
                    </span>
                    <span data-slot="command-readback">{spec.readback}</span>
                  </div>
                  <div data-slot="command-phrases">
                    <For each={spec.phrases.slice(0, 3)}>
                      {(phrase) => (
                        <button
                          type="button"
                          data-slot="phrase-chip"
                          title={t("vui.commands.usePhrase")}
                          onClick={() => {
                            setTrialText(phrase)
                            document.getElementById("voice-trial-input")?.focus()
                          }}
                        >
                          {phrase}
                        </button>
                      )}
                    </For>
                  </div>
                </div>
              )}
            </For>
          </div>
          <p id="voice-command-count" data-slot="hint">
            {t("vui.commands.count", filteredCommands().length, VOCABULARY.length)}
          </p>
        </section>
        </div>
      </div>

      {/*
        The live console, under both columns.

        It used to sit above the sections, which meant that testing the mic
        after changing the engine — the one thing anybody wants to do after
        changing the engine — required scrolling back to the top. Down here it
        spans the panel and stays put whichever section is open.
      */}
      <div data-slot="live" data-running={engineRunning() ? "true" : undefined}>
        <div data-slot="meter" aria-hidden="true">
          <For each={METER_WEIGHTS}>
            {(weight, index) => (
              <span
                data-slot="meter-bar"
                style={{
                  height: `${engineRunning() ? 14 + Math.min(micLevel() * 2.2, 1) * weight * 86 : 16 + weight * 10}%`,
                  "animation-delay": `${index() * 45}ms`,
                }}
              />
            )}
          </For>
        </div>

        <div data-slot="live-text">
          <p data-slot="live-line" data-kind={liveLine().kind}>
            {liveLine().text}
          </p>
          <Show when={props.engine.lastError()}>
            <p data-slot="live-error" role="alert">
              {props.engine.lastError()}
            </p>
          </Show>
        </div>

        <div data-slot="live-actions">
          <Show when={engineRunning()}>
            <button
              type="button"
              data-slot="ghost-btn"
              onClick={() => void props.engine.cancel()}
              title={t("vui.live.cancel.tip")}
            >
              {t("vui.live.cancel")}
            </button>
          </Show>
          <button
            type="button"
            data-slot="primary-btn"
            data-listening={engineRunning() ? "true" : undefined}
            onClick={toggleListening}
            aria-pressed={engineRunning()}
          >
            {engineRunning() ? t("vui.live.stop") : t("vui.live.start")}
          </button>
        </div>
      </div>

      {/* Footer */}
      <div data-slot="footer">
        <span data-slot="footer-hint">
          {t("vui.footer.keys")}
        </span>
        <Show when={!props.inline && props.onClose}>
          <button type="button" data-slot="solid-btn" onClick={props.onClose}>
            {t("vui.footer.done")}
          </button>
        </Show>
      </div>
    </div>
  )

  return (
    <Show
      when={!props.inline}
      fallback={renderPanel()}
    >
      <div
        data-component="voice-settings-overlay"
        onClick={handleBackdropClick}
      >
        {renderPanel()}
      </div>
    </Show>
  )
}
