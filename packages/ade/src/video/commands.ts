/**
 * Turning a request from an agent into something the video panel did.
 *
 * Separate from the component for the usual reason — a `.tsx` cannot be
 * imported under `bun test` here — but also because this is where the panel
 * is *answerable*. Every verb has to come back with a sentence that is true:
 * an agent that is told "ok — a 30,0 s" and is actually at 12 s will spend
 * its next three turns reasoning about the wrong frame, and nothing in the
 * interface will contradict it.
 *
 * So the controller below is the whole surface the commands may touch, and
 * every outcome is built from what the controller reports *after* the
 * action rather than from what was asked for.
 */

import type { PanelOutcome, PanelRequest } from "../panels/protocol"
import {
  clampSeek,
  describeState,
  formatTimecode,
  isPlayable,
  parseRate,
  parseTimecode,
  PLAYABLE_EXTENSIONS,
  VIDEO_VERBS,
  type VideoState,
} from "./video"

/**
 * What the panel lets a command do.
 *
 * Deliberately small and deliberately synchronous except where it cannot be:
 * loading a file and encoding a frame are the only two things that wait.
 */
export interface VideoController {
  state(): VideoState
  /** Resolves to the path actually opened, or rejects with a readable reason. */
  open(path: string): Promise<string>
  play(): Promise<void>
  pause(): void
  /** Seeks and resolves to where it landed. */
  seek(seconds: number): Promise<number>
  setRate(rate: number): void
  /** Saves the current frame and resolves to the path it was written to. */
  capture(): Promise<string>
}

/** The verbs this module implements, for `describeCapabilities`. */
export const VERBS = VIDEO_VERBS

export async function runVideoCommand(controller: VideoController, request: PanelRequest): Promise<PanelOutcome> {
  const argument = request.args[0]

  switch (request.verb) {
    case "open": {
      if (!argument) return fail("manca il percorso del file")
      if (!isPlayable(argument)) {
        // Named rather than implied: an agent told only "non riproducibile"
        // will try the same file again with a different verb.
        return fail(`formato non riproducibile; supportati: ${PLAYABLE_EXTENSIONS.join(", ")}`)
      }
      try {
        const opened = await controller.open(argument)
        return ok(`aperto ${opened}`)
      } catch (error) {
        return fail(reasonOf(error))
      }
    }

    case "play": {
      if (!controller.state().source) return fail("nessun video aperto")
      try {
        await controller.play()
      } catch (error) {
        /*
         * A webview refuses to play without a gesture from the user, and it
         * refuses by rejecting rather than by staying still. Reported as a
         * success the agent would go on to capture frames that never move.
         */
        return fail(reasonOf(error))
      }
      return ok(describeState(controller.state()))
    }

    case "pause": {
      if (!controller.state().source) return fail("nessun video aperto")
      controller.pause()
      return ok(describeState(controller.state()))
    }

    case "seek": {
      const state = controller.state()
      if (!state.source) return fail("nessun video aperto")
      if (!argument) return fail("manca il tempo, es. 1:03 oppure 12.5")
      const wanted = parseTimecode(argument)
      if (wanted === undefined) return fail(`"${argument}" non è un tempo, es. 1:03 oppure 12.5`)

      const landed = await controller.seek(clampSeek(wanted, state.duration))
      // Reported from where it landed, not from what was asked: a seek past
      // the end is silently ignored by the element.
      const note = landed < wanted - 0.05 ? " (fine del video)" : ""
      return ok(`a ${formatTimecode(landed)}${note}`)
    }

    case "step": {
      const state = controller.state()
      if (!state.source) return fail("nessun video aperto")
      if (!argument) return fail("manca lo spostamento in secondi, es. -0.5")
      const delta = Number(argument.replace(",", "."))
      if (!Number.isFinite(delta)) return fail(`"${argument}" non è un numero di secondi`)

      const landed = await controller.seek(clampSeek(state.position + delta, state.duration))
      return ok(`a ${formatTimecode(landed)}`)
    }

    case "rate": {
      if (!controller.state().source) return fail("nessun video aperto")
      if (!argument) return fail("manca il fattore di velocità, es. 0.5")
      const rate = parseRate(argument)
      if (rate === undefined) return fail(`"${argument}" non è una velocità fra 0.25 e 4`)
      controller.setRate(rate)
      return ok(`velocità ${controller.state().rate}×`)
    }

    case "capture": {
      if (!controller.state().source) return fail("nessun video aperto")
      try {
        const path = await controller.capture()
        /*
         * The path, and the instant it belongs to. The agent is about to
         * read the file, and which frame it is holding is the only thing
         * the image itself cannot tell it.
         */
        return ok(`${path} — fotogramma a ${formatTimecode(controller.state().position)}`)
      } catch (error) {
        return fail(reasonOf(error))
      }
    }

    case "state":
      return ok(describeState(controller.state()))

    default:
      return fail(`comando sconosciuto; disponibili: ${VIDEO_VERBS.map((verb) => verb.name).join(", ")}`)
  }
}

function ok(detail: string): PanelOutcome {
  return { ok: true, detail }
}

function fail(reason: string): PanelOutcome {
  return { ok: false, reason }
}

/**
 * A reason the agent can act on.
 *
 * `String(error)` on a DOMException gives "NotAllowedError: …", which is the
 * useful half; an object with no message gives "[object Object]", which is
 * worse than a generic sentence.
 */
function reasonOf(error: unknown): string {
  if (error instanceof Error && error.message) return error.message
  if (typeof error === "string" && error.length > 0) return error
  return "non riuscito"
}
