/**
 * The heads-up widget that appears while the microphone is open.
 *
 * It replaces a modal overlay that dimmed the workbench and trapped the
 * pointer behind a backdrop. That was the wrong shape for the job: speaking to
 * an agent is something you do *while* watching a session run, and a dialog
 * that covers the thing you are talking about — and blocks the clicks you were
 * about to make — turns a hands-free feature into a modal interruption.
 *
 * So: a pill at the bottom of the window, over everything and in the way of
 * nothing. It appears when the mic opens, follows what is being heard, and
 * leaves when the mic closes. Only the pill itself takes the pointer; the rest
 * of the strip is transparent to it, so the terminals underneath stay live.
 *
 * Two widgets, not one with a switch, because the two modes are answering
 * different questions:
 *
 *   trascrizione — "is it getting my words right?" The words are the content:
 *                  they stream across the pill as they are heard, and the only
 *                  other thing shown is where they are about to land.
 *
 *   agente       — "did it understand, and what is it about to do?" The words
 *                  are a means; the readback, the confirmation and the
 *                  execution state are the content. It carries the dialogue
 *                  the engine actually runs — a destructive command asks first,
 *                  an ambiguous one offers its two candidates.
 *
 * Neither takes focus when it appears. A widget that stole the caret would
 * interrupt the typing it exists to avoid interrupting.
 */

import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js"
import type { VoiceEngine } from "../engine"
import { OrbMark } from "./orb-mark"
import { orbLevel } from "./voice-orb"
import {
  agentHudState,
  latestExchange,
  HUD_WAVE,
  orbRim,
  preparingHudState,
  waveBarHeight,
  type HudState,
} from "./voice-hud-state"
import "./voice-hud.css"
import { t } from "@nikcli-ai/ade/i18n"

export interface VoiceHudProps {
  /** The voice control engine instance. */
  engine: VoiceEngine
  /** Forces visibility. When omitted, the widget follows the engine. */
  open?: boolean
  /** Where dictated text is headed, shown so it is never a surprise. */
  target?: string
  /** Fired when the user clicks the target chip to cycle to another session. */
  onCycleTarget?: () => void
  /** Fired when the user dismisses the widget. */
  onClose?: () => void
  /** Fired when the user asks to open settings from a configuration/key error. */
  onOpenSettings?: () => void
}

/** The live level bars. Shared by both widgets — the mic is the mic. */
function Wave(props: { level: number; running: boolean }) {
  return (
    <span data-slot="hud-wave" aria-hidden="true">
      <For each={HUD_WAVE}>
        {(weight, index) => (
          <i
            style={{
              height: `${waveBarHeight(weight, props.level, props.running)}%`,
              "animation-delay": `${index() * 55}ms`,
            }}
          />
        )}
      </For>
    </span>
  )
}

export function VoiceHud(props: VoiceHudProps) {
  const status = () => props.engine.status()
  const running = () => props.engine.isRunning()
  const partial = () => props.engine.partialTranscript()
  const spoken = () => props.engine.lastSpoken()
  const level = () => props.engine.micLevel()
  /*
   * Which of the two has the microphone, not which one is the default.
   *
   * The widget read `settings().mode`, so a session opened for dictation from
   * the dictation chord still drew the agent pill — the stored setting had not
   * changed, and the widget was reporting the preference rather than the fact.
   */
  const mode = () => props.engine.activeMode()
  const dialog = () => props.engine.dialogState()
  const parse = () => props.engine.lastParseResult()
  const error = () => props.engine.lastError()

  /** Set while the local model is still being fetched, and nothing can be heard yet. */
  const preparing = createMemo(() => props.engine.parakeetProgress())

  /*
   * The orb's collar: green while it hears you, red when it is broken, amber
   * when the microphone has not been granted. The rule is in `orbRim`, where
   * it can be checked without a DOM; what is here is only which signals feed
   * it. All three pills share it, so the ring means the same thing whichever
   * shape the widget has taken.
   */
  const rim = createMemo(() =>
    orbRim({
      running: running(),
      errorKind: props.engine.lastErrorKind(),
      preparing: preparing() !== undefined,
    }),
  )

  /*
   * The last failure the user has already seen and waved away.
   *
   * Kept here rather than in the engine because dismissing is a fact about this
   * widget, not about the session: the engine's error is still the last thing
   * that went wrong, and a second press that fails the same way should say so
   * again rather than stay quiet because the first one was acknowledged.
   */
  const [dismissedError, setDismissedError] = createSignal<string>()

  /*
   * A start that fails leaves the microphone shut, and a widget that is only
   * visible while the microphone is open therefore says nothing at all — which
   * is how "no API key" and "model would not load" both reached the user as a
   * button that does nothing when pressed. The failure gets the pill instead.
   */
  const failure = createMemo(() => {
    const message = props.engine.lastError()
    if (!message || running() || preparing()) return undefined
    return message === dismissedError() ? undefined : message
  })

  /*
   * Visible whenever the mic is open — not only when there is something to
   * read. The widget is the answer to "is it listening right now?", and a
   * widget that appears only once you have already spoken answers that
   * question too late to be worth asking.
   *
   * It appears for the warm-up too, which is the same question one step
   * earlier: the first use of the local model downloads it, and that wait is
   * far too long to spend showing nothing.
   */
  const readback = createMemo(() => {
    const result = parse()
    return result?.outcome === "matched" ? result.intent?.readback : undefined
  })

  const candidates = createMemo(() => {
    const result = parse()
    if (result?.outcome !== "ambiguous") return []
    return (result.candidates ?? []).slice(0, 2)
  })

  /*
   * S33: the agent has its own widget now, the sphere in `agent-orb.tsx`, and
   * the pill is dictation's. The agent pill still comes up for the two moments
   * that need buttons — a destructive command asking first, an ambiguous one
   * offering its candidates — because a sphere has nowhere to put "sì" and "no".
   */
  const agentNeedsPill = () => status() === "confirming" || candidates().length >= 2

  const visible = createMemo(() =>
    props.open !== undefined
      ? props.open
      : (running() && (mode() === "transcription" || agentNeedsPill())) ||
        preparing() !== undefined ||
        failure() !== undefined,
  )

  const state = createMemo<HudState>(() => {
    const warmup = preparing()
    if (warmup) return preparingHudState({ percent: warmup.percent })
    return agentHudState({
      status: status(),
      partial: partial(),
      spoken: spoken(),
      readback: readback(),
      wakeWord: props.engine.settings().wakeWord,
      ...latestExchange(props.engine.history()),
    })
  })

  /**
   * What the dictation has collected, as one line.
   *
   * Two sources, because there are two dictations. The dialogue machine's
   * buffer is the assistant's "detta un prompt" intent; `engine.dictated()` is
   * transcription mode, which never touches that machine — and which, with the
   * cloud backend, emits no partials either. Reading only the first left this
   * empty for the whole of a dictation session.
   */
  const dictated = createMemo(() => {
    const chunks = dialog().dictation?.chunks ?? []
    const parts = chunks.length > 0 ? chunks : props.engine.dictated()
    const text = [...parts, partial()].filter((part) => part.trim().length > 0).join(" ")
    return text.trim()
  })

  const dismiss = () => {
    const shown = failure()
    if (shown) setDismissedError(shown)
    void props.engine.cancel()
    props.onClose?.()
  }

  /*
   * Escape reaches the widget from wherever the caret happens to be, because
   * the widget never took it. It cancels the phrase rather than closing the
   * mic: stopping mid-sentence is the common correction, and shutting the mic
   * off would make the user re-arm it to try again.
   */
  createEffect(() => {
    if (typeof window === "undefined" || !visible()) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return
      event.preventDefault()
      dismiss()
    }
    window.addEventListener("keydown", onKey)
    onCleanup(() => window.removeEventListener("keydown", onKey))
  })

  return (
    <Show when={visible()}>
      <div data-component="voice-hud" data-mode={mode()}>
        <Show when={failure()}>
          {(message) => (
            <section
              data-slot="hud-pill"
              data-kind="failure"
              data-tone="failed"
              role="alert"
              aria-label={t("vui.hud.failed.label")}
            >
              {/* Shut, because it is: a start that failed left the microphone
                  closed, and the orb is the one thing on screen that can say
                  so without a word. */}
              <span data-slot="hud-mark">
                <OrbMark awake={false} status="asleep" level={0} rim={rim()} />
              </span>
              <span data-slot="hud-body">
                <span data-slot="hud-label">{t("vui.hud.failed")}</span>
                <span data-slot="hud-line">{message()}</span>
              </span>
              <Show when={props.onOpenSettings}>
                <button
                  type="button"
                  data-slot="hud-settings"
                  onClick={() => {
                    dismiss()
                    props.onOpenSettings?.()
                  }}
                  aria-label={t("vui.hud.settings.label")}
                  title={t("vui.hud.settings.label")}
                  style={{
                    background: "none",
                    border: "none",
                    color: "var(--accent, #60a5fa)",
                    cursor: "pointer",
                    "font-size": "11px",
                    "text-decoration": "underline",
                    "margin-left": "4px",
                    "margin-right": "4px",
                    padding: "2px 4px",
                  }}
                >
                  {t("vui.hud.settings")}
                </button>
              </Show>
              <button type="button" data-slot="hud-esc" onClick={dismiss} aria-label={t("vui.hud.close")}>
                esc
              </button>
            </section>
          )}
        </Show>

        <Show when={!failure()}>
          <Show
            when={mode() === "transcription"}
            fallback={
              /* ── agente ───────────────────────────────────────────────── */
              <section
                data-slot="hud-pill"
                data-kind="agent"
                data-tone={state().tone}
                role="status"
                aria-live="polite"
                aria-label={t("vui.hud.agent.label")}
              >
                {/*
                The same orb the toolbar draws, at the widget's size.

                It used to be this file's own disc: an ink circle with the
                block mark laid on it and a ring that scaled with the level.
                That made the widget and the bar two objects sharing a logo,
                each with its own idea of what listening looks like — and the
                two drifted, because nothing held them together. One drawing
                now, and the widget inherits every state the orb learns.
              */}
                <span data-slot="hud-orb">
                  <OrbMark
                    awake={running()}
                    status={status()}
                    mode={mode()}
                    level={orbLevel(level(), running())}
                    rim={rim()}
                  />
                </span>

                <span data-slot="hud-body">
                  <span data-slot="hud-label">{state().label}</span>
                  <span data-slot="hud-line" data-quoted={state().quoted ? "true" : undefined}>
                    {state().line}
                  </span>
                </span>

                <Wave level={level()} running={running()} />

                {/* A destructive command asks before it runs; the voice answer is
                  the point, and the buttons are the way out when the room is
                  loud enough that saying it twice has already failed. */}
                <Show when={status() === "confirming" && dialog().pendingAction}>
                  <span data-slot="hud-actions">
                    <button type="button" data-slot="hud-btn" onClick={() => void props.engine.submitText("annulla")}>
                      {t("vui.hud.no")}
                    </button>
                    <button
                      type="button"
                      data-slot="hud-btn"
                      data-primary="true"
                      onClick={() => void props.engine.submitText("conferma")}
                    >
                      {t("vui.hud.yes")}
                    </button>
                  </span>
                </Show>

                <Show when={candidates().length >= 2}>
                  <span data-slot="hud-actions">
                    <For each={candidates()}>
                      {(candidate, index) => (
                        <button
                          type="button"
                          data-slot="hud-btn"
                          title={candidate.intent.readback}
                          onClick={() => void props.engine.submitText(index() === 0 ? "la prima" : "la seconda")}
                        >
                          {index() === 0 ? t("vui.hud.first") : t("vui.hud.second")}
                        </button>
                      )}
                    </For>
                  </span>
                </Show>

                <button type="button" data-slot="hud-esc" onClick={dismiss} aria-label={t("vui.hud.cancel")}>
                  esc
                </button>
              </section>
            }
          >
            {/* ── trascrizione ───────────────────────────────────────────── */}
            <section
              data-slot="hud-pill"
              data-kind="transcription"
              data-tone={preparing() ? "working" : partial().length > 0 ? "listening" : "armed"}
              role="status"
              aria-live="polite"
              aria-label={t("vui.hud.transcription.label")}
            >
              <span data-slot="hud-mark">
                <OrbMark
                  awake={running()}
                  status={status()}
                  mode="transcription"
                  level={orbLevel(level(), running())}
                  rim={rim()}
                />
              </span>

              <Wave level={level()} running={running()} />

              {/*
              The words are the widget. They run to the right edge and are
              clipped from the left, the way a caret keeps the newest text in
              view — what was said thirty seconds ago is already in the pane.
            */}
              <span data-slot="hud-said" data-empty={dictated().length === 0 ? "true" : undefined}>
                {preparing() ? state().line : dictated().length > 0 ? dictated() : t("vui.hud.listeningNow")}
              </span>

              <Show when={props.target && !preparing()}>
                <button
                  type="button"
                  data-slot="hud-target"
                  onClick={(e) => {
                    e.stopPropagation()
                    props.onCycleTarget?.()
                  }}
                  title={
                    props.onCycleTarget
                      ? t("vui.hud.target.cycle", props.target ?? "")
                      : t("vui.hud.target", props.target ?? "")
                  }
                  style={props.onCycleTarget ? { cursor: "pointer" } : undefined}
                >
                  → {props.target}
                </button>
              </Show>

              <button type="button" data-slot="hud-esc" onClick={dismiss} aria-label={t("vui.hud.cancel")}>
                esc
              </button>
            </section>
          </Show>
        </Show>

        {/* Errors ride under the pill rather than replacing it: the mic is
            still open, and the widget must go on saying so. Not while the
            failure pill is up — that one is already the message. */}
        <Show when={error() && !failure()}>
          <p data-slot="hud-error" role="alert">
            {error()}
          </p>
        </Show>
      </div>
    </Show>
  )
}
