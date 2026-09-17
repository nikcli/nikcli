/**
 * The always-on indicator beside the orb; see `listening-state.ts`.
 */

import { Show, createMemo } from "solid-js"
import type { VoiceEngine } from "../engine"
import { listeningState } from "./listening-state"
import "./listening-indicator.css"

export function ListeningIndicator(props: { engine: VoiceEngine }) {
  const state = createMemo(() =>
    listeningState({
      settings: props.engine.settings(),
      running: props.engine.isRunning(),
      mode: props.engine.activeMode(),
      paused: props.engine.listenPaused(),
      followUp: props.engine.followUp() !== undefined,
    }),
  )
  const visible = createMemo(() => {
    const current = state()
    return current.kind === "hidden" ? undefined : current
  })
  // Keyed: paused and listening are both shown, and the button has to be rebuilt between them.
  return (
    <Show when={visible()} keyed>
      {(current) => (
        <button
          type="button"
          data-component="listening-indicator"
          data-state={current.kind}
          title={current.title}
          aria-label={current.title}
          onClick={() =>
            void (current.kind !== "paused"
              ? props.engine.stop()
              : props.engine.start("agent", { waitForName: true }))
          }
        >
          <i data-slot="listening-dot" />
          {current.text}
        </button>
      )}
    </Show>
  )
}
