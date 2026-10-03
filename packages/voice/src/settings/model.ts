/**
 * Settings domain model for voice interaction and transcription modes.
 *
 * Provides typed settings schemas, sensible defaults, and resilient
 * normalization that repairs corrupt or legacy payloads without throwing.
 */

import { describeChordRisk } from "./shortcuts"
import type { TranscriberBackend } from "../asr/select"
import { t } from "@nikcli-ai/ade/i18n"

export type VoiceMode = "agent" | "transcription"

export type VoiceActivation = "push-to-talk" | "toggle" | "wake-word"

export type TranscriptionSendMode = "manual" | "auto"
/**
 * How the dictation chord opens the microphone: held while speaking, or a
 * switch — one tap opens it and the next closes it.
 */
export type DictationPress = "hold" | "toggle"

export const AGENT_ENGINES = ["auto", "claude", "codex", "nikcli", "off"] as const
export type AgentEngine = (typeof AGENT_ENGINES)[number]

/**
 * How the agent is asked to think. `fast`: Sonnet 5 with little effort on
 * Claude Code, little effort on Codex, which is what a spoken answer needs.
 * `cli`: whatever the CLI is set to, for someone who wants its own model.
 */
export const AGENT_SPEEDS = ["fast", "cli"] as const
export type AgentSpeed = (typeof AGENT_SPEEDS)[number]

/**
 * The voice replies are read in: a local voice ADE downloads on first use, or
 * `system` for the Web Speech voice. The user's choice (D19): «ugo per
 * maschile, e piper per femminile, selezionabile dalle impostazioni» — Ugo,
 * the default, and Paola.
 *
 * The Kokoro ids are English voices (D95) and join the same union on purpose:
 * the choice the user makes is a voice, and which backend speaks it is a fact
 * about the voice, in `REPLY_BACKEND_BY_VOICE`. A second union would make the
 * panel offer a Kokoro id on a Piper profile, which is a combination that
 * cannot speak.
 */
export const REPLY_VOICES = [
  "ugo",
  "paola",
  "lessac",
  "af_heart",
  "am_fenrir",
  "bf_emma",
  "bm_george",
  "system",
] as const
export type ReplyVoice = (typeof REPLY_VOICES)[number]

/**
 * What reads the replies. Piper and Kokoro are local and downloaded; `system`
 * is the Web Speech voice, always there and never better.
 *
 * No `gemini` here on purpose: that plan is not started, and the rule the two
 * plans agree on is that whoever arrives second adds only its own migration
 * step. When it does, this union and one step in `normalizeSettings` are all
 * that changes, and the version after `CURRENT_SETTINGS_VERSION` is its own.
 */
export const REPLY_BACKENDS = ["piper", "kokoro", "system"] as const
export type ReplyBackend = (typeof REPLY_BACKENDS)[number]

/** The last voice picked on each local backend; the system voice has only one. */
export type ReplyVoiceMemory = Readonly<Partial<Record<Exclude<ReplyBackend, "system">, ReplyVoice>>>

/**
 * The G2P locale the replies are spoken in, and the only source of it.
 *
 * Not the interface language, not the language the agent answers in, and not
 * the recogniser's: this is the locale the synthesiser is asked for, and it is
 * allowlisted because a synthesiser that does not know a locale fails on the
 * sentence instead of on the setting. The mapping to what the G2P is handed is
 * `g2pLocale` in `reply-voices.ts`, and it is not the identity — see there.
 */
export const TTS_LOCALES = ["it-IT", "en-US", "en-GB"] as const
export type TtsLocale = (typeof TTS_LOCALES)[number]

/**
 * Which backend can speak each voice. One fact per voice, and the pair is
 * validated together: a profile that names a voice and a backend that
 * disagree has named a combination that cannot speak.
 */
export const REPLY_BACKEND_BY_VOICE: Readonly<Record<ReplyVoice, ReplyBackend>> = {
  ugo: "piper",
  paola: "piper",
  lessac: "piper",
  af_heart: "kokoro",
  am_fenrir: "kokoro",
  bf_emma: "kokoro",
  bm_george: "kokoro",
  system: "system",
}

/**
 * 2: the assistant answers when it is called by name.
 *
 * With the microphone open and no name to wait for, everything the room said
 * was a request — a television in the background ran up a bill and opened
 * sessions. A profile written before this is moved to the wake word once; the
 * switch in the voice settings turns it back off.
 *
 * 3: the assistant listens all the time and answers to one fixed phrase,
 * «ei nik». The name is no longer a setting, so every profile is moved to it,
 * and a profile on the wake word is told once that listening is now always on.
 *
 * 4: the user's decision for 0.7.0 — the assistant is started only by its
 * shortcut, or the button that does the same. With `WAKE_WORD_ENABLED` off, a
 * profile on the wake word is moved to push-to-talk once, and told.
 *
 * 5: the same for "toggle": a microphone left open hears the television and
 * the room. One press, one turn.
 *
 * 6: the user's decision after 0.7.0 — the assistant is started only by
 * voice, a sentence that begins with «ei nik» or «nik». A profile on the
 * shortcut or on toggle is moved to always-on listening for the name once,
 * and told. The shortcut and the button stay, as a manual way to call it.
 *
 * 7: the user's rule after 0.7.2 — listening for the name without being
 * asked spends money in the background: every noise the detector takes for
 * speech is a paid transcription. Listening on its own is now off unless it
 * is chosen, and a profile that had it is turned off once, and told.
 *
 * 8: Kokoro, as a second local backend, and the locale the replies are spoken
 * in. Every profile until now had a Piper voice or the system one, and took
 * its language from the voice; the locale becomes a setting of its own, and it
 * starts from that same language. Nothing is offered and nothing is
 * downloaded: Kokoro is opt-in, so a profile arrives on Piper as it left, and
 * the Gemini plan, when it lands, takes the version after this one.
 */
export const CURRENT_SETTINGS_VERSION = 8

/**
 * Whether the wake word and always-on listening exist. The switch, like Chat
 * and Bot's: off, they cannot be chosen, nothing opens the microphone by
 * itself, and a stored choice of them becomes the shortcut. On since 0.7.1.
 */
export const WAKE_WORD_ENABLED = true

/**
 * Whether push-to-talk and toggle can be chosen as the way the assistant is
 * started. Off: the name is the only way, and a stored choice of either moves
 * to it. The code and its tests stay behind this switch.
 */
export const SHORTCUT_ACTIVATION_ENABLED = false

let shortcutActivationSwitch = SHORTCUT_ACTIVATION_ENABLED
export function shortcutActivationEnabled(): boolean {
  return shortcutActivationSwitch
}
export function setShortcutActivationEnabledForTests(on: boolean): void {
  shortcutActivationSwitch = on
}

let wakeWordSwitch = WAKE_WORD_ENABLED
/** The switch as it reads now. Only tests move it, to keep the dormant path checked. */
export function wakeWordEnabled(): boolean {
  return wakeWordSwitch
}
export function setWakeWordEnabledForTests(on: boolean): void {
  wakeWordSwitch = on
}

/**
 * The name that calls the assistant. Fixed, by the user's decision: «nik» or
 * «ei nik» at the start of the sentence. The greeting is accepted in front of
 * the name, and what the recogniser makes of either — «ehi nik», «hey nick» —
 * by `settings/wake-word.ts`.
 */
export const WAKE_PHRASE = "nik"

export interface VoiceSettings {
  /** Schema version used to govern migrations across configuration upgrades. */
  readonly version: number
  /** Primary operational mode: executing agent commands or streaming raw text. */
  readonly mode: VoiceMode
  /** Trigger mechanism determining when the microphone listens. */
  readonly activation: VoiceActivation
  /** Delivery behaviour for transcribed text inside the active composer. */
  readonly transcriptionSend: TranscriptionSendMode
  /** Target recognition language as an ISO-639-1 code (e.g. 'it'). */
  readonly language: string
  /** Spoken wake-phrase waking the assistant in wake-word mode; always `WAKE_PHRASE`. */
  readonly wakeWord: string
  /**
   * Whether ADE opens the microphone by itself and waits for `WAKE_PHRASE`.
   *
   * Only meaningful with the wake word: a microphone that is always open and
   * obeys everything would obey the television. While it waits, only the
   * first second and a half of each sentence goes to the cloud; see
   * `asr/openrouter.ts`.
   */
  readonly alwaysListen: boolean
  /** Keyboard chord triggering or toggling agent command mode. */
  readonly agentChord: string
  /** Keyboard chord triggering or toggling transcription mode. */
  readonly transcriptionChord: string
  /**
   * Whether the dictation chord is held while speaking or works as a switch.
   * Held is the default: a dictation left open sends the room to the pane.
   */
  readonly dictationPress: DictationPress
  /** Selected speech-to-text transcription engine. */
  readonly backend: TranscriberBackend
  /** Optional OpenRouter cloud speech API authentication key. */
  readonly openRouterApiKey?: string
  /**
   * Words the speech model has never heard, spelled the way the user writes them.
   *
   * Every ASR model decodes into its training vocabulary, and the words that
   * matter most here are not in it: "nikcli", "opencode", "worktree", "xterm".
   * They come back split, respelled or translated, and the result is dictated
   * into a coding agent's prompt — where a wrong identifier is not a typo but
   * a wrong instruction. See `asr/custom-words.ts` for how close a fragment
   * must be before it is corrected.
   */
  readonly customWords: readonly string[]
  /**
   * Whether the assistant reads an agent's answer back out loud.
   *
   * On by default, because the alternative is what this used to be: the
   * dictated prompt goes to the session, the assistant confirms it sent it,
   * and the answer arrives silently on a screen the user may have turned away
   * from — which makes a voice *agent* a dictation machine. Off is for someone
   * watching the pane anyway, who wants the microphone and not the voice.
   */
  readonly speakReplies: boolean
  /**
   * Whether the assistant announces session events on its own: permissions,
   * task completions, or open decisions.
   *
   * Off by default to avoid unexpected speech or consumption (S48). When on,
   * it speaks a brief announcement and opens a single 6-8s response window.
   */
  readonly spokenAlerts: boolean
  /** Which voice reads them; see `REPLY_VOICES`. */
  readonly replyVoice: ReplyVoice
  /**
   * What reads the replies: a local backend or the system voice; see
   * `REPLY_BACKENDS`. Not a free choice — it is the backend of the voice in
   * `REPLY_BACKEND_BY_VOICE`, and normalization puts the two back together when
   * a profile arrives with them disagreeing.
   */
  readonly replyBackend: ReplyBackend
  /**
   * The voice last picked on each local backend, so that going to another one
   * and back finds it again: Paola, then Kokoro, then Piper is Paola, not the
   * first Piper voice. Absent: nothing remembered, the backend's first voice.
   */
  readonly replyVoiceByBackend?: ReplyVoiceMemory
  /**
   * The G2P locale the replies are spoken in; see `TTS_LOCALES`.
   *
   * Separate from `language`, which is what the recogniser is asked for, and
   * from the interface language: a Kokoro voice chosen for an English answer
   * says nothing about which language the microphone listens in, and an
   * Italian answer on a Kokoro voice falls back to Piper rather than being read
   * with an English mouth. See `replyVoiceFor` in `reply-voices.ts`.
   */
  readonly ttsLocale: TtsLocale
  /**
   * What answers a sentence the grammar does not know.
   *
   * The grammar covers what people say often, instantly and offline. The rest
   * goes to a coding agent's CLI — Claude Code, Codex or nikcli — running as a
   * turn with the user's own sign-in, so it spends the subscription they
   * already have rather than a key billed per request, and it can manage
   * ADE's sessions through `ade-msg`. `auto` takes the first of those that is
   * installed; `off` keeps the old behaviour (the OpenRouter planner, when a
   * key is set).
   */
  readonly agentEngine: AgentEngine
  /** See `AGENT_SPEEDS`. */
  readonly agentSpeed: AgentSpeed
  /**
   * Whether to retry a request on Codex if Claude Code hits its plan rate limit.
   *
   * Off by default. When on, if agentEngine is "auto" and Claude Code returns a plan
   * rate limit error, the request is retried once on Codex after announcing the switch.
   */
  readonly codexFallback: boolean
  /**
   * Which microphone to listen on. Absent means the system default.
   *
   * A `MediaDeviceInfo.deviceId`, which is an opaque hash scoped to this
   * origin — it is not a name, it is not portable between machines, and it
   * changes if the user revokes and regrants permission. So it is stored as a
   * hint and never as a requirement: the device it names may be unplugged, and
   * the capture asks for it with `ideal` so that falls back to the default
   * rather than failing to open anything. See `audio/capture.ts`.
   */
  readonly inputDeviceId?: string
  /**
   * Which speaker to answer through. Absent means the system default.
   *
   * Honoured only by a speaker that plays through a media element — see
   * `tts/speaker.ts`. The Web Speech synthesiser has no sink selection of any
   * kind and always goes to the system default, so this setting is offered
   * only where it can actually be obeyed.
   */
  readonly outputDeviceId?: string
}

export const DEFAULT_VOICE_SETTINGS: VoiceSettings = Object.freeze({
  version: CURRENT_SETTINGS_VERSION,
  mode: "agent",
  activation: WAKE_WORD_ENABLED && !SHORTCUT_ACTIVATION_ENABLED ? "wake-word" : "push-to-talk",
  transcriptionSend: "manual",
  language: "it",
  wakeWord: WAKE_PHRASE,
  /*
   * Off: an open microphone that sends the start of every sentence it hears
   * to the cloud costs the user money for a room they are not talking to.
   * Measured in a room with a television on: about 330 paid requests an
   * hour. It is a choice now, made in the voice settings, where what it
   * costs is written.
   */
  alwaysListen: false,
  agentChord: "mod+shift+k",
  transcriptionChord: "mod+shift+j",
  dictationPress: "hold",
  /*
   * The cloud engine, despite needing a key and sending audio away.
   *
   * The only engine. There was a local one (Parakeet) and it is gone: running
   * a 0.6B model inside the webview took the renderer past four gigabytes and
   * stopped it answering, whichever accelerator it picked. Local transcription
   * that does not freeze the window needs a process of its own, not a tab.
   */
  backend: "openrouter",
  /*
   * Empty, not seeded with this project's own jargon.
   *
   * A correction list is a promise that a word will come out one specific
   * way, and shipping that promise for words the user has not asked about
   * means their speech is being rewritten by a default they never saw. The
   * panel offers the list; what goes in it is theirs.
   */
  customWords: Object.freeze([]),
  speakReplies: true,
  spokenAlerts: false,
  replyVoice: "ugo",
  replyBackend: "piper",
  /*
   * Italian, because the default voice is Ugo and the default language of the
   * profile is Italian: a new profile speaks what it has always spoken. A
   * profile that had Lessac arrives on English, in `legacyReplyLocale`.
   */
  ttsLocale: "it-IT",
  agentEngine: "auto",
  agentSpeed: "fast",
  codexFallback: false,
})

export interface NormalizedVoiceSettings extends VoiceSettings {
  /** Self-reference to settings allowing destructuring as { settings, corrections }. */
  readonly settings: VoiceSettings
  /** List of repair descriptions applied in Italian for UI feedback. */
  readonly corrections: readonly string[]
  /**
   * What this load changed under the user, named rather than described.
   *
   * The interface has to find these to show them where they can be undone,
   * and finding them by searching the Italian sentence for a word breaks the
   * first time the sentence is reworded.
   */
  readonly migrations: readonly VoiceMigration[]
}

/**
 * `wake-word`: a profile that answered everything now waits to be called.
 * `always-listen`: a profile on the wake word now listens without being opened.
 * `shortcut-only`: a profile on the wake word is back on the shortcut.
 * `name-only`: a profile on the shortcut or toggle now listens for the name.
 * `listening-off`: a profile that listened on its own no longer does.
 * `parakeet-removed`: a profile on the local engine that is gone is now on the cloud one.
 * `parakeet-listening-off`: and it listened on its own, which would have sent every voice in the room
 * to the cloud one, so it no longer does.
 *
 * There is deliberately no migration for a Kokoro voice in the wrong language:
 * the voice that reads such a reply is decided per reply, so there is nothing on
 * disk to move and nothing to put back.
 */
export type VoiceMigration =
  | "wake-word"
  | "always-listen"
  | "shortcut-only"
  | "name-only"
  | "listening-off"
  | "parakeet-removed"
  | "parakeet-listening-off"

/**
 * The locale a profile written before version 8 was really speaking in.
 *
 * It had no locale of its own: the language came from the voice, and the voice
 * still knows it. Lessac is the English one, Ugo and Paola the Italian ones,
 * and the system voice speaks whatever the window does — there the profile's
 * own recorded language is the only evidence there is, and "it" is what a
 * profile with none says.
 */
function legacyReplyLocale(candidate: Record<string, unknown>): TtsLocale {
  if (candidate.replyVoice === "lessac") return "en-US"
  if (candidate.replyVoice === "system") return candidate.language === "en" ? "en-US" : "it-IT"
  return "it-IT"
}

/**
 * Version 8: the backend the voice belongs to, and the locale it speaks.
 *
 * Both come from the voice the profile already names, so a profile is left
 * speaking what it was speaking. Kokoro is not offered here and nothing is
 * downloaded: a profile arrives on Piper exactly as it left, which is the whole
 * point of a backend that is opt-in.
 *
 * A function and not a block inside the versioned branch because a profile with
 * no `version` at all is older than every version, and it reaches the same
 * place by the other road: without this it would keep a Piper voice and lose the
 * language that voice was in.
 */
function toKokoro(candidate: Record<string, unknown>): Record<string, unknown> {
  return {
    ...candidate,
    replyBackend: candidate.replyVoice === "system" ? "system" : "piper",
    ttsLocale: legacyReplyLocale(candidate),
  }
}

/**
 * A profile on the shortcut or toggle, moved to listening for the name: the
 * assistant's default, always on. Its default mode becomes the agent's, since
 * the name only calls the agent; dictation keeps its own shortcut.
 */
function toName(candidate: Record<string, unknown>, migrations: VoiceMigration[]): Record<string, unknown> {
  if (!wakeWordEnabled() || shortcutActivationEnabled()) return candidate
  if (candidate.activation !== "push-to-talk" && candidate.activation !== "toggle") return candidate
  migrations.push("name-only")
  // Not `alwaysListen`: the name works in a microphone the user opened.
  return { ...candidate, activation: "wake-word", mode: "agent" }
}

/**
 * Why a stored chord cannot be used, in Italian, or undefined when it can.
 *
 * Storage is reachable without the panel — a hand-edited profile, a settings
 * file copied between machines, a build that wrote an older shape — so the
 * same safety rule the recorder applies has to be applied again on the way in.
 * Otherwise the one chord the UI refuses to record is still the one a file can
 * install, and it would arrive holding a key the user needs to type with.
 *
 * Judged on "other" because the rule is about which modifiers lift a keystroke
 * out of typing, and that does not change with the platform; `mod` resolves to
 * Ctrl here and to Cmd on a Mac, and both count as lifted.
 */
function chordProblem(chordStr: unknown): string | undefined {
  if (typeof chordStr !== "string" || chordStr.trim().length === 0) {
    return t("vui.fix.noMainKey")
  }
  const risk = describeChordRisk(chordStr.trim(), "other")
  if (risk.level !== "refuse") return undefined
  return risk.message ?? t("vui.shortcut.invalid")
}

/**
 * Validates and repairs arbitrary settings objects into canonical VoiceSettings.
 *
 * Guarantees:
 * - Never throws on null, undefined, primitives, or malformed data.
 * - Out-of-domain properties safely fall back to DEFAULT_VOICE_SETTINGS.
 * - Records Italian explanations for all repairs applied.
 */
export function normalizeSettings(raw: unknown): NormalizedVoiceSettings {
  const corrections: string[] = []

  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    corrections.push(t("vui.fix.defaults"))
    return {
      ...DEFAULT_VOICE_SETTINGS,
      settings: DEFAULT_VOICE_SETTINGS,
      corrections,
      migrations: [],
    }
  }

  let candidate = raw as Record<string, unknown>

  // 1. Version migration
  const migrations: VoiceMigration[] = []
  let version = candidate.version
  if (typeof version !== "number" || Number.isNaN(version)) {
    corrections.push(t("vui.fix.noVersion"))
    /* A profile with no version is older than any of them: a "toggle" in it
       goes back to the shortcut like a versioned one. */
    if (!wakeWordEnabled() && candidate.activation === "toggle") {
      candidate = { ...candidate, activation: "push-to-talk" }
      migrations.push("shortcut-only")
    }
    candidate = toName(candidate, migrations)
    if (candidate.alwaysListen === true) {
      candidate = { ...candidate, alwaysListen: false }
      if (wakeWordEnabled()) migrations.push("listening-off")
    }
    candidate = toKokoro(candidate)
    version = CURRENT_SETTINGS_VERSION
  } else if (version < CURRENT_SETTINGS_VERSION) {
    // Not a repair: a newer version is not something that went wrong, and
    // a correction is shown at startup in the warning strip.
    /*
     * The one migration this version carries: an assistant that answered
     * everything it heard now waits to be called. Only "toggle" is moved —
     * push-to-talk already has a key holding the microphone open, and a
     * profile already on the wake word is left alone.
     */
    if (wakeWordEnabled() && version < 2 && candidate.activation === "toggle") {
      candidate = { ...candidate, activation: "wake-word" }
      migrations.push("wake-word")
      corrections.push(t("vui.fix.wakeDefault"))
    }
    /*
     * Version 3: listening is always on for whoever waits for the name. Told
     * once, where the switch that turns it off is.
     */
    if (
      wakeWordEnabled() &&
      version < 3 &&
      candidate.activation === "wake-word" &&
      candidate.mode !== "transcription"
    ) {
      migrations.push("always-listen")
    }
    /* Version 5: a stored "toggle" goes back to the shortcut too. */
    if (!wakeWordEnabled() && version < 5 && candidate.activation === "toggle") {
      candidate = { ...candidate, activation: "push-to-talk" }
      migrations.push("shortcut-only")
    }
    /* Version 6: the name is the only way to start it. */
    if (version < 6) candidate = toName(candidate, migrations)
    /*
     * Version 7: listening on its own is off until it is chosen. Every
     * profile until now had it, by default or by choice, so it is turned off
     * once and said where to turn it back on.
     */
    if (version < 7 && candidate.alwaysListen === true) {
      candidate = { ...candidate, alwaysListen: false }
      // Nothing to tell where listening for the name does not exist at all.
      if (wakeWordEnabled()) migrations.push("listening-off")
    }
    /*
     * Version 8: Kokoro arrives, and with it the locale the replies are spoken
     * in. See `toKokoro`.
     */
    if (version < 8) candidate = toKokoro(candidate)
    version = CURRENT_SETTINGS_VERSION
  }

  // 2. Mode
  let mode: VoiceMode
  if (candidate.mode === "agent" || candidate.mode === "transcription") {
    mode = candidate.mode
  } else {
    corrections.push(t("vui.fix.mode", String(candidate.mode), DEFAULT_VOICE_SETTINGS.mode))
    mode = DEFAULT_VOICE_SETTINGS.mode
  }

  /*
   * Version 4, and any profile that still names the wake word while it is
   * switched off: back to the shortcut, quietly — nothing went wrong.
   */
  if (!wakeWordEnabled() && candidate.activation === "wake-word") {
    candidate = { ...candidate, activation: "push-to-talk" }
    if (!migrations.includes("shortcut-only")) migrations.push("shortcut-only")
  }

  // 3. Activation
  let activation: VoiceActivation
  if (
    candidate.activation === "push-to-talk" ||
    candidate.activation === "toggle" ||
    candidate.activation === "wake-word"
  ) {
    activation = candidate.activation
  } else {
    corrections.push(t("vui.fix.activation", String(candidate.activation), DEFAULT_VOICE_SETTINGS.activation))
    activation = DEFAULT_VOICE_SETTINGS.activation
  }

  // 4. Transcription send mode
  let transcriptionSend: TranscriptionSendMode
  if (candidate.transcriptionSend === "manual" || candidate.transcriptionSend === "auto") {
    transcriptionSend = candidate.transcriptionSend
  } else {
    corrections.push(t("vui.fix.send", String(candidate.transcriptionSend), DEFAULT_VOICE_SETTINGS.transcriptionSend))
    transcriptionSend = DEFAULT_VOICE_SETTINGS.transcriptionSend
  }

  // 5. Language code (ISO-639-1)
  let language: string
  if (typeof candidate.language === "string" && candidate.language.trim().length > 0) {
    language = candidate.language.trim().toLowerCase()
  } else {
    corrections.push(t("vui.fix.language", DEFAULT_VOICE_SETTINGS.language))
    language = DEFAULT_VOICE_SETTINGS.language
  }

  // 6. Wake word: fixed. Whatever was stored — "hei nik", a name the user
  // typed — is replaced without a word; the phrase is not theirs to set now.
  const wakeWord = WAKE_PHRASE
  let alwaysListen = DEFAULT_VOICE_SETTINGS.alwaysListen
  if (typeof candidate.alwaysListen === "boolean") alwaysListen = candidate.alwaysListen

  // 7. Agent chord shortcut
  let agentChord: string
  const agentChordProblem = chordProblem(candidate.agentChord)
  if (!agentChordProblem) {
    agentChord = String(candidate.agentChord).trim()
  } else {
    corrections.push(
      t("vui.fix.agentChord", String(candidate.agentChord), agentChordProblem, DEFAULT_VOICE_SETTINGS.agentChord),
    )
    agentChord = DEFAULT_VOICE_SETTINGS.agentChord
  }

  // 8. Transcription chord shortcut
  let transcriptionChord: string
  const transcriptionChordProblem = chordProblem(candidate.transcriptionChord)
  if (!transcriptionChordProblem) {
    transcriptionChord = String(candidate.transcriptionChord).trim()
  } else {
    corrections.push(
      t(
        "vui.fix.transcriptionChord",
        String(candidate.transcriptionChord),
        transcriptionChordProblem,
        DEFAULT_VOICE_SETTINGS.transcriptionChord,
      ),
    )
    transcriptionChord = DEFAULT_VOICE_SETTINGS.transcriptionChord
  }

  // 9. Backend
  //
  // Settings saved before the browser recogniser was removed name a backend
  // that no longer exists; they fall through to the default here, which is the
  // same path any other unknown value takes and needs no special case.
  // "parakeet", the local engine that has been removed, becomes the cloud one.
  // It is told once (`parakeet-removed`), because what was free and private now
  // leaves the machine; the model it downloaded is dropped once, elsewhere
  // (`asr/legacy-parakeet.ts`). Listening on its own is turned off with it: a
  // profile that heard every phrase in the room for nothing would otherwise send
  // every one of them to a paid service, under the user, on the first start.
  let backend: TranscriberBackend
  if (candidate.backend === "parakeet") {
    backend = "openrouter"
    migrations.push("parakeet-removed")
    if (alwaysListen) {
      alwaysListen = false
      migrations.push("parakeet-listening-off")
    }
  } else if (candidate.backend === "openrouter") {
    backend = "openrouter"
  } else {
    corrections.push(t("vui.fix.backend", String(candidate.backend), DEFAULT_VOICE_SETTINGS.backend))
    backend = DEFAULT_VOICE_SETTINGS.backend
  }

  // 10. OpenRouter API Key (optional)
  let openRouterApiKey: string | undefined = undefined
  if (typeof candidate.openRouterApiKey === "string" && candidate.openRouterApiKey.trim().length > 0) {
    openRouterApiKey = candidate.openRouterApiKey.trim()
  }

  /*
   * 12. Custom words.
   *
   * Kept as strings the user typed, minus whitespace-only entries and
   * duplicates. Deduplicated case-insensitively because two spellings of the
   * same word would both be candidates and the transcript would flip between
   * them depending on which happened to score first.
   */
  const customWords: string[] = []
  if (Array.isArray(candidate.customWords)) {
    const seen = new Set<string>()
    let dropped = 0
    for (const entry of candidate.customWords) {
      if (typeof entry !== "string") {
        dropped += 1
        continue
      }
      const word = entry.trim()
      if (word.length === 0) continue
      const key = word.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      customWords.push(word)
    }
    if (dropped > 0) {
      corrections.push(t("vui.fix.wordsDropped", String(dropped)))
    }
  } else if (candidate.customWords !== undefined) {
    corrections.push(t("vui.fix.wordsInvalid"))
  }

  /*
   * 13. Spoken replies.
   *
   * Only an explicit `false` turns it off. A profile written before this
   * setting existed has `undefined` here, and reading that as "off" would
   * leave every existing user with the silent behaviour this exists to end.
   */
  let speakReplies = DEFAULT_VOICE_SETTINGS.speakReplies
  if (typeof candidate.speakReplies === "boolean") {
    speakReplies = candidate.speakReplies
  } else if (candidate.speakReplies !== undefined) {
    corrections.push(t("vui.fix.speakReplies"))
  }
  let spokenAlerts = DEFAULT_VOICE_SETTINGS.spokenAlerts
  if (typeof candidate.spokenAlerts === "boolean") {
    spokenAlerts = candidate.spokenAlerts
  } else if (candidate.spokenAlerts !== undefined) {
    corrections.push(t("vui.fix.spokenAlerts"))
  }
  let replyVoice = DEFAULT_VOICE_SETTINGS.replyVoice
  if (REPLY_VOICES.includes(candidate.replyVoice as ReplyVoice)) {
    replyVoice = candidate.replyVoice as ReplyVoice
  } else if (candidate.replyVoice !== undefined) {
    corrections.push(t("vui.fix.replyVoice", String(candidate.replyVoice)))
  }

  /*
   * 14. The locale the replies are spoken in.
   *
   * Allowlisted, because a synthesiser handed a locale it does not know fails
   * on the sentence rather than on the setting, and the answer would look like
   * a broken voice. Absent in every profile written before version 8, and that
   * is the default, so absent says nothing.
   */
  let ttsLocale = DEFAULT_VOICE_SETTINGS.ttsLocale
  if (TTS_LOCALES.includes(candidate.ttsLocale as TtsLocale)) {
    ttsLocale = candidate.ttsLocale as TtsLocale
  } else if (candidate.ttsLocale !== undefined) {
    corrections.push(t("vui.fix.ttsLocale", String(candidate.ttsLocale)))
  }

  /*
   * 15. The backend, and the pair with the voice.
   *
   * The voice is what the user picked and what the panel names, so it decides:
   * a profile that says `af_heart` on `piper` gets the Kokoro backend, and one
   * that says `ugo` on `kokoro` gets Piper. The other way round would be worse
   * in both directions — a Kokoro id on the Piper backend is a voice that
   * cannot speak, and a Piper id on the Kokoro backend is a voice the host
   * does not have at all.
   *
   * A repair, so it is said: the pair was written together and does not come
   * apart on its own.
   */
  let replyBackend = REPLY_BACKEND_BY_VOICE[replyVoice]
  if (candidate.replyBackend !== undefined && candidate.replyBackend !== replyBackend) {
    corrections.push(t("vui.fix.replyBackend", String(candidate.replyBackend), replyBackend))
  }

  // Only a voice of that backend is remembered under it: anything else is forgotten, never moved.
  const replyVoiceByBackend: Partial<Record<Exclude<ReplyBackend, "system">, ReplyVoice>> = {}
  const remembered = candidate.replyVoiceByBackend
  if (remembered && typeof remembered === "object") {
    for (const local of ["piper", "kokoro"] as const) {
      const voice = (remembered as Record<string, unknown>)[local]
      if (REPLY_VOICES.includes(voice as ReplyVoice) && REPLY_BACKEND_BY_VOICE[voice as ReplyVoice] === local) {
        replyVoiceByBackend[local] = voice as ReplyVoice
      }
    }
  }

  /*
   * A Kokoro voice in the wrong language is left exactly where the profile put
   * it, and this is where a reviewer will look for the code that moves it.
   *
   * There was one, and it was wrong twice. It overwrote the id the user had
   * chosen, so the migration that claimed it could be put back had nothing to
   * put it back to, and `loadVoiceSettings` writes a migrated profile straight
   * back, which made the loss permanent. And the write-back only runs when the
   * version changed while a remap is not a version, so the sentence was produced
   * again at every start: the banner repeated for as long as the app was opened.
   *
   * It is not needed. The voice that reads a reply is decided from the text of
   * that reply, per reply, by `speakingReplyVoice`: an Italian answer on an
   * English Kokoro voice goes to Ugo or Paola with nothing written anywhere, and
   * the choice comes back by itself the first time an answer is in English. A
   * migration that moves nothing cannot be irreversible, and cannot repeat.
   */

  /*
   * 16. The chosen audio devices, if any were chosen.
   *
   * Optional strings, kept when they are not empty and dropped otherwise, with
   * no correction message either way — the same shape as the API key above and
   * for the same reason: absent is a perfectly good value (it means "whatever
   * the system uses"), so a profile that has never touched the picker must not
   * be greeted with two repair notices.
   *
   * Nothing here checks that the device still exists. It cannot: this function
   * is synchronous and pure, and the answer changes when a cable is moved. The
   * check belongs where the device is opened, which is why `capture.ts` asks
   * for it as `ideal`.
   */
  let inputDeviceId: string | undefined = undefined
  if (typeof candidate.inputDeviceId === "string" && candidate.inputDeviceId.trim().length > 0) {
    inputDeviceId = candidate.inputDeviceId.trim()
  }

  let outputDeviceId: string | undefined = undefined
  if (typeof candidate.outputDeviceId === "string" && candidate.outputDeviceId.trim().length > 0) {
    outputDeviceId = candidate.outputDeviceId.trim()
  }

  /*
   * 17. The agent engine.
   *
   * Absent in every profile written before it existed, and that is the
   * default, so absent says nothing. Only a value that is present and not one
   * of the engines is repaired aloud.
   */
  let agentEngine = DEFAULT_VOICE_SETTINGS.agentEngine
  if (AGENT_ENGINES.includes(candidate.agentEngine as AgentEngine)) {
    agentEngine = candidate.agentEngine as AgentEngine
  } else if (candidate.agentEngine !== undefined) {
    corrections.push(t("vui.fix.agentEngine", String(candidate.agentEngine)))
  }

  // 18. The agent's speed: absent in older profiles, which get the fast one.
  let agentSpeed = DEFAULT_VOICE_SETTINGS.agentSpeed
  if (AGENT_SPEEDS.includes(candidate.agentSpeed as AgentSpeed)) {
    agentSpeed = candidate.agentSpeed as AgentSpeed
  } else if (candidate.agentSpeed !== undefined) {
    corrections.push(t("vui.fix.agentSpeed", String(candidate.agentSpeed)))
  }

  // 19. The fallback to Codex on Claude plan limit: absent in older profiles, which get the default (false).
  let codexFallback = DEFAULT_VOICE_SETTINGS.codexFallback
  if (typeof candidate.codexFallback === "boolean") {
    codexFallback = candidate.codexFallback
  } else if (candidate.codexFallback !== undefined) {
    corrections.push(t("vui.fix.codexFallback"))
  }

  // A profile from before the choice existed has none, and gets the default without a note.
  const dictationPress: DictationPress = candidate.dictationPress === "toggle" ? "toggle" : "hold"

  const cleanSettings: VoiceSettings = {
    version: Number(version),
    mode,
    activation,
    transcriptionSend,
    dictationPress,
    language,
    wakeWord,
    alwaysListen,
    agentChord,
    transcriptionChord,
    backend,
    ...(openRouterApiKey ? { openRouterApiKey } : {}),
    customWords,
    speakReplies,
    spokenAlerts,
    replyVoice,
    replyBackend,
    ...(Object.keys(replyVoiceByBackend).length > 0 ? { replyVoiceByBackend } : {}),
    ttsLocale,
    agentEngine,
    agentSpeed,
    codexFallback,
    ...(inputDeviceId ? { inputDeviceId } : {}),
    ...(outputDeviceId ? { outputDeviceId } : {}),
  }

  return {
    ...cleanSettings,
    settings: cleanSettings,
    corrections,
    migrations,
  }
}
