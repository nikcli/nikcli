/**
 * @nikcli-ai/voice
 * Pure logical core for 100% voice control of ADE in Italian.
 */

// Bridge and host contract
export type { AdeView, PaneStatus, PaneSummary, VoiceHost, VoiceStateSnapshot } from "./bridge/host"

// The agent console's record of the session
export { appendEntry, groupIntoTurns, MAX_AGENT_ENTRIES, type AgentEntry, type AgentTurn } from "./agent/log"

export { dispatch, resolveTargetPane, type DispatchContext, type DispatchOutcome } from "./bridge/dispatch"

// Intent recognition and parsing
export { VOCABULARY, type VoiceIntentSpec, type VoiceSlotName } from "./intent/vocabulary"

export { normalizeAccents, normalizeUtterance, stripFillers, wordsToNumbers } from "./intent/normalize"

export {
  AMBIGUITY_MARGIN,
  MATCH_CONFIDENCE_THRESHOLD,
  parseUtterance,
  type CandidateMatch,
  type ParseContext,
  type ParseResult,
} from "./intent/parse"

// Dialogue state machine
export {
  createInitialDialogState,
  DEFAULT_CONFIRMATION_TIMEOUT_MS,
  DEFAULT_PERMISSION_TIMEOUT_MS,
  transition,
  type DialogEffect,
  type DialogEvent,
  type DialogState,
  type DialogStatus,
  type DictationBuffer,
  type PendingAction,
  type TransitionResult,
} from "./dialog/session"

// Automated speech recognition (ASR)
export {
  type FinalTranscriptCallback,
  type PartialTranscriptCallback,
  type Transcriber,
  type TranscriberErrorCallback,
  type TranscriberOptions,
  type TranscriptEvent,
} from "./asr/transcriber"

export { createFakeTranscriber, type FakeTranscriber } from "./asr/fake"

// Audio level and silence detection
export {
  calculateRms,
  createInitialSpeechDetectorState,
  createSpeechDetector,
  DEFAULT_MIN_SPEECH_DURATION_MS,
  DEFAULT_SILENCE_TIMEOUT_MS,
  DEFAULT_SPEECH_THRESHOLD,
  stepSpeechDetector,
  type SpeechDetectorConfig,
  type SpeechDetectorState,
  type SpeechState,
} from "./audio/level"

export { createMicMeter, type MicLevelCallback, type MicMeter, type MicMeterOptions } from "./audio/meter"

// Which microphone and which speaker
export {
  describeChoice,
  listAudioDevices,
  onDeviceChange,
  shapeDevices,
  SYSTEM_DEFAULT,
  type AudioDevice,
  type AudioDevices,
} from "./audio/devices"

// The downloaded model, on disk
export {
  clearModelCache,
  downloadParakeetModel,
  EMPTY_CACHE,
  inspectModelCache,
  requestPersistentStorage,
  type CachedModel,
  type DownloadParakeetOptions,
  type DownloadParakeetProgress,
  type DownloadParakeetProgressCallback,
} from "./asr/model-cache"

// Text to speech (TTS)
export {
  createFakeSpeaker,
  createWebSpeechSpeaker,
  pickBestVoice,
  type FakeSpeaker,
  type Speaker,
  type WebSpeechSpeakerOptions,
} from "./tts/speaker"
export {
  createNaturalSpeaker,
  splitSentences,
  type NaturalSpeaker,
  type NaturalSpeakerDeps,
} from "./tts/natural-speaker"
export {
  createPlaybackMeter,
  levelAt,
  syntheticSpeechLevel,
  wavEnvelope,
  type Envelope,
  type PlaybackMeter,
} from "./tts/playback-level"
export { orbPhase, orbCentered, type OrbPhase } from "./ui/agent-orb-state"

export {
  replySpeech,
  summariseForSpeech,
  type ReplyReason,
  type ReplySummaryOptions,
  type SpeakableLine,
} from "./tts/reply"

// Planning: what the hand-written grammar cannot match
export { announceExecution, executePlan, type PlanExecution } from "./plan/execute"

export {
  buildPlannerPrompt,
  createOpenRouterCompletion,
  extractJson,
  planUtterance,
  PLANNER_MODEL,
  type Completion,
  type PlannerResult,
} from "./plan/planner"

export {
  MAX_PLAN_STEPS,
  PLANNABLE_COMMANDS,
  resolveAgent,
  resolveProject,
  validatePlan,
  type PlanContext,
  type PlanStep,
  type ValidatedPlan,
} from "./plan/schema"

// Voice orchestration engine
export { createVoiceEngine, holdsToTalk, type VoiceEngine, type VoiceEngineOptions } from "./engine"

// Solid UI components
export { VoiceButton, type VoiceButtonProps } from "./ui/voice-button"

export { VoiceOrb, orbLevel, type VoiceOrbProps } from "./ui/voice-orb"
export { ListeningIndicator } from "./ui/listening-indicator"
export { listeningState, type ListeningState } from "./ui/listening-state"

export { OrbMark, type OrbMarkProps, type OrbRim } from "./ui/orb-mark"

export { VoiceHud, type VoiceHudProps } from "./ui/voice-hud"
export { AgentOrb, type AgentOrbProps } from "./ui/agent-orb"

export { NikMic, type NikMicProps } from "./ui/nik-mic"

export { NikLogo, type NikLogoProps } from "./ui/nik-logo"

export { NikCube, type NikCubeProps } from "./ui/nik-cube"

export { VoiceSettingsPanel, type VoiceSettingsPanelProps } from "./ui/voice-settings-panel"

export {
  captureKeyboardEvent,
  checkShortcutConflict,
  formatMaskedApiKey,
  getPlatform,
  suggestClosestLanguage,
  type ConflictCheckResult,
  type KeyInput,
  type ShortcutCaptureResult,
} from "./ui/shortcut-capture"

// Multi-engine microphone capture and audio pipeline
export {
  chooseSupportedAudioMimeType,
  createMicCapture,
  MAX_SEGMENT_DURATION_MS,
  MIN_SEGMENT_DURATION_MS,
  resamplePcm,
  type AudioFormat,
  type CapturedSegment,
  type MicCapture,
  type MicCaptureOptions,
  type SupportedAudioFormat,
} from "./audio/capture"

// Local neural ASR (Parakeet TDT 0.6B v3 via parakeet.js)
export {
  createParakeetTranscriber,
  describeParakeetReadiness,
  disposeParakeetModel,
  isParakeetModelWarmedUp,
  isWasmAvailable,
  isWebGpuAvailable,
  warmupParakeetModel,
  type ParakeetBackend,
  type ParakeetProgress,
  type ParakeetProgressCallback,
  type ParakeetReadiness,
  type ParakeetTranscriber,
  type ParakeetTranscriberOptions,
  type WarmupParakeetOptions,
} from "./asr/parakeet-local"

// Cloud ASR (OpenRouter microsoft/mai-transcribe-2)
export {
  blobToBase64,
  createOpenRouterTranscriber,
  MAX_AUDIO_BYTES,
  mimeToAudioFormat,
  OPENROUTER_ENDPOINT,
  OPENROUTER_MODEL,
  OPENROUTER_TIMEOUT_MS,
  sanitizeApiKey,
  type OpenRouterAudioFormat,
  type OpenRouterTranscriber,
  type OpenRouterTranscriberOptions,
  type OpenRouterUsage,
  type OpenRouterUsageCallback,
} from "./asr/openrouter"

// Repairing words the speech model has never heard
export {
  correctCustomWords,
  DEFAULT_WORD_CORRECTION_THRESHOLD,
  editDistance,
  normalizeForMatch,
  type CustomWordCorrection,
  type CustomWordResult,
} from "./asr/custom-words"

// Multi-backend selector & readiness diagnostics
export {
  createTranscriberFor,
  describeBackends,
  type BackendDescriptions,
  type BackendStatus,
  type SelectTranscriberOptions,
  type TranscriberBackend,
} from "./asr/select"

// Effect-TS backend architecture
export {
  ApiKeyInvalid,
  ApiKeyMissing,
  AudioFormatUnsupported,
  HostActionFailed,
  MicPermissionDenied,
  MicUnavailable,
  ModelLoadFailed,
  QuotaExhausted,
  RequestTimeout,
  SpeechRecognitionUnavailable,
  TranscriptionFailed,
  spokenMessage,
  type VoiceError,
} from "./effect/errors"

export {
  MicCapture as MicCaptureTag,
  Speaker as SpeakerTag,
  Transcriber as TranscriberTag,
  VoiceHostService,
  type MicCaptureService,
  type SpeakerService,
  type TranscriberEvent,
  type TranscriberService,
} from "./effect/services"

export {
  MicCaptureLive,
  SpeakerFake,
  SpeakerLive,
  TranscriberFake,
  TranscriberOpenRouterLive,
  TranscriberParakeetLive,
  TranscriberSelectLive,
  VoiceHostLive,
  bridgeTranscriber,
  mapToVoiceError,
} from "./effect/layers"

export {
  dispatchTranscription,
  makeVoiceProgram,
  type ExternalCommand,
  type VoiceProgramHandle,
  type VoiceProgramOptions,
} from "./effect/program"

// Voice settings, storage, languages, wake word, and shortcuts
export {
  CURRENT_SETTINGS_VERSION,
  AGENT_ENGINES,
  REPLY_VOICES,
  type ReplyVoice,
  DEFAULT_VOICE_SETTINGS,
  WAKE_PHRASE,
  WAKE_WORD_ENABLED,
  wakeWordEnabled,
  setWakeWordEnabledForTests,
  SHORTCUT_ACTIVATION_ENABLED,
  shortcutActivationEnabled,
  setShortcutActivationEnabledForTests,
  type AgentEngine,
  AGENT_SPEEDS,
  type AgentSpeed,
  normalizeSettings,
  type NormalizedVoiceSettings,
  type ParakeetExecutionBackend,
  type TranscriptionSendMode,
  type VoiceActivation,
  type VoiceMode,
  type VoiceSettings,
} from "./settings/model"

export {
  VOICE_API_KEY_STORAGE_KEY,
  VOICE_SETTINGS_STORAGE_KEY,
  clearVoiceSettings,
  // The point of `exportVoiceSettings` is that other code can hand settings
  // out with the credential provably absent. Left off this list, it could
  // not be reached from outside the package and the safe route did not exist.
  exportVoiceSettings,
  loadVoiceSettings,
  resetVoiceSettings,
  saveVoiceSettings,
} from "./settings/storage"

export {
  availableLanguages,
  formatLanguageLabel,
  isLanguageSupported,
  type AvailableLanguagesOptions,
  type LanguageOption,
} from "./settings/languages"

export { matchesWakeWord, type WakeWordMatch } from "./settings/wake-word"

export {
  VOICE_COMMAND_AGENT,
  VOICE_COMMAND_TRANSCRIPTION,
  buildVoiceBindings,
  describeChordRisk,
  describeCommandId,
  describeShortcut,
  findVoiceShortcutConflicts,
  isChordUsable,
  summarizeVoiceShortcutConflicts,
  type ChordRisk,
  type ChordRiskLevel,
} from "./settings/shortcuts"
