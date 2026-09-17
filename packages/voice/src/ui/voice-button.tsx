/**
 * The microphone button — dictation, and by default the plain toggle.
 *
 * Since the assistant got an orb of its own (`voice-orb.tsx`), this is the
 * other half of the pair: a microphone glyph for the thing a microphone
 * actually is, putting spoken words into the focused pane without anyone
 * interpreting them. Give it `mode="transcription"` and it lights only when
 * *it* is the one holding the microphone; with no mode it is the old
 * unqualified toggle, which is still what a host with a single control wants.
 *
 * Fully operable via keyboard (Enter / Space) with dynamic Italian ARIA
 * announcements.
 */

import { createMemo, Show } from "solid-js"
import type { VoiceEngine } from "../engine"
import type { DialogStatus } from "../dialog/session"
import type { VoiceMode } from "../settings/model"
import { NikMic } from "./nik-mic"
import "./voice.css"
import { t } from "@nikcli-ai/ade/i18n"

export interface VoiceButtonProps {
  /** The voice control engine instance. */
  engine: VoiceEngine
  /**
   * Which of the two features this button is.
   *
   * Set it and the button owns one mode: pressing it opens the microphone for
   * that mode, or takes the microphone from the other control, and it reads as
   * pressed only while that mode is the live one. Left unset the button is a
   * plain on/off for whatever the stored default is.
   */
  mode?: VoiceMode
  /** Optional extra CSS class names. */
  class?: string
}

function getAriaLabelForStatus(status: DialogStatus, isRunning: boolean): string {
  if (!isRunning || status === "asleep") {
    return t("vui.button.off")
  }
  switch (status) {
    case "idle":
    case "listening":
      return t("vui.button.listening")
    case "confirming":
      return t("vui.button.confirming")
    case "executing":
      return t("vui.button.executing")
    case "dictating":
      return t("vui.button.dictating")
  }
}

function dictationLabel(mine: boolean, running: boolean): string {
  if (mine) return t("vui.dictation.mine")
  if (running) return t("vui.dictation.busy")
  return t("vui.dictation.idle")
}

export function VoiceButton(props: VoiceButtonProps) {
  const status = () => props.engine.status()
  const isRunning = () => props.engine.isRunning()
  const micLevel = () => props.engine.micLevel()

  /* Whether the open microphone is this button's. Without a mode the button
     owns whatever is running, which is the single-control behaviour. */
  const isMine = () =>
    isRunning() && (props.mode === undefined || props.engine.activeMode() === props.mode)

  const ariaLabel = createMemo(() =>
    props.mode === "transcription"
      ? dictationLabel(isMine(), isRunning())
      : getAriaLabelForStatus(status(), isRunning()),
  )

  const ringScale = createMemo(() => {
    const lvl = micLevel()
    return 1 + Math.min(lvl * 1.5, 0.5)
  })

  const ringOpacity = createMemo(() => {
    const lvl = micLevel()
    return Math.min(0.3 + lvl * 1.4, 0.95)
  })

  const press = () => void props.engine.toggle(props.mode)

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault()
      press()
    }
  }

  return (
    <button
      type="button"
      data-component="voice-button"
      data-status={isMine() ? status() : "asleep"}
      data-active={isMine() ? "true" : undefined}
      data-mode={props.mode}
      class={props.class}
      aria-label={ariaLabel()}
      title={ariaLabel()}
      aria-pressed={isMine()}
      tabIndex={0}
      onClick={press}
      onKeyDown={handleKeyDown}
    >
      <Show when={isMine()}>
        <span
          data-slot="mic-ring"
          style={{
            transform: `scale(${ringScale()})`,
            opacity: `${ringOpacity()}`,
          }}
          aria-hidden="true"
        />
      </Show>

      {/*
        Solid rather than hairline: at 16px in a toolbar the outlined N silts
        up inside the capsule, and a mark you cannot resolve is worse than a
        generic one. Knocked out against the button's own ground so the letter
        stays legible whether or not the mic is live.
      */}
      <span data-slot="mic-icon" aria-hidden="true">
        <NikMic size={16} variant="solid" knockout="var(--ade-surface)" />
      </span>
    </button>
  )
}
