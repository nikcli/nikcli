/**
 * Turning a request from an agent into something the 3D panel did.
 *
 * The same shape as `video/commands.ts`: the controller is the whole surface
 * a command may touch, and every reply is built from what the controller
 * reports after the action, never from what was asked for.
 */

import type { PanelOutcome, PanelRequest } from "../panels/protocol"
import {
  describeModelState,
  isModel,
  MODEL_EXTENSIONS,
  MODEL_VERBS,
  parseView,
  VIEW_PRESETS,
  type ModelState,
  type ViewPreset,
} from "./model"

export interface ModelController {
  state(): ModelState
  /** Resolves once the model is on screen, or rejects with a readable reason. */
  open(path: string): Promise<void>
  reload(): Promise<void>
  view(preset: ViewPreset): void
  /** Saves the current view and resolves to the path it was written to. */
  capture(): Promise<string>
}

export async function runModelCommand(controller: ModelController, request: PanelRequest): Promise<PanelOutcome> {
  const argument = request.args[0]

  switch (request.verb) {
    case "open": {
      if (!argument) return fail("manca il percorso del file")
      if (!isModel(argument)) return fail(`formato non supportato; supportati: ${MODEL_EXTENSIONS.join(", ")}`)
      return settle(() => controller.open(argument), controller)
    }

    case "reload": {
      if (!controller.state().source) return fail("nessun modello aperto")
      return settle(() => controller.reload(), controller)
    }

    case "view": {
      if (!controller.state().stats) return fail("nessun modello caricato")
      const preset = argument ? parseView(argument) : undefined
      if (!preset) return fail(`vista sconosciuta; disponibili: ${Object.keys(VIEW_PRESETS).join(", ")}`)
      controller.view(preset)
      return ok(`vista ${preset}`)
    }

    case "capture": {
      if (!controller.state().stats) return fail("nessun modello caricato")
      try {
        return ok(`vista salvata in ${await controller.capture()}`)
      } catch (error) {
        return fail(reasonOf(error))
      }
    }

    case "state":
      return ok(describeModelState(controller.state()))

    default:
      return fail(`comando sconosciuto; disponibili: ${MODEL_VERBS.map((verb) => verb.name).join(", ")}`)
  }
}

/** Runs a load and answers with what is on screen afterwards. */
async function settle(action: () => Promise<void>, controller: ModelController): Promise<PanelOutcome> {
  try {
    await action()
  } catch (error) {
    return fail(reasonOf(error))
  }
  const state = controller.state()
  // A load that "succeeded" into an error state is still a failure to report.
  if (state.error) return fail(state.error)
  return ok(describeModelState(state))
}

function ok(detail: string): PanelOutcome {
  return { ok: true, detail }
}

function fail(reason: string): PanelOutcome {
  return { ok: false, reason }
}

function reasonOf(error: unknown): string {
  if (error instanceof Error && error.message) return error.message
  if (typeof error === "string" && error.length > 0) return error
  return "non riuscito"
}
