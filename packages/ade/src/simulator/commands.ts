/**
 * Turning a request from an agent into something the app simulator did.
 *
 * Same shape as the video and 3D panels: the controller is the whole surface,
 * and the reply is built from the state after the action.
 */

import type { PanelOutcome, PanelRequest } from "../panels/protocol"
import { DEVICES, describeSimulator, parseAppUrl, parseSize, SIMULATOR_VERBS, type SimulatorState } from "./simulator"

export interface SimulatorController {
  state(): SimulatorState
  /** Loads the URL and resolves to whether its server answered. */
  open(url: string): Promise<boolean>
  setDevice(id: string): void
  rotate(): void
  setWindowSize(size: { width: number; height: number }): void
  reload(): Promise<boolean>
}

export async function runSimulatorCommand(
  controller: SimulatorController,
  request: PanelRequest,
): Promise<PanelOutcome> {
  const argument = request.args.join(" ")

  switch (request.verb) {
    case "open": {
      const url = parseAppUrl(argument)
      if (!url) return fail("URL non valido; es. 5173, localhost:8081 o http://127.0.0.1:3000")
      try {
        const reachable = await controller.open(url)
        const described = describeSimulator(controller.state())
        return reachable ? ok(described) : fail(described)
      } catch (error) {
        return fail(reasonOf(error))
      }
    }

    case "device": {
      const device = DEVICES.find((candidate) => candidate.id === argument.trim().toLowerCase())
      if (!device) return fail(`dispositivo sconosciuto; disponibili: ${DEVICES.map((known) => known.id).join(", ")}`)
      controller.setDevice(device.id)
      return ok(describeSimulator(controller.state()))
    }

    case "rotate": {
      if (controller.state().device.kind === "window") return fail("una finestra desktop non ruota; usa size")
      controller.rotate()
      return ok(describeSimulator(controller.state()))
    }

    case "size": {
      if (controller.state().device.kind !== "window")
        return fail("size vale per la finestra desktop; prima device window")
      const size = parseSize(argument)
      if (!size) return fail("dimensione non valida; es. 1280x800")
      controller.setWindowSize(size)
      return ok(describeSimulator(controller.state()))
    }

    case "reload": {
      if (!controller.state().url) return fail("nessuna app aperta")
      const reachable = await controller.reload()
      const described = describeSimulator(controller.state())
      return reachable ? ok(described) : fail(described)
    }

    case "state":
      return ok(describeSimulator(controller.state()))

    default:
      return fail(`comando sconosciuto; disponibili: ${SIMULATOR_VERBS.map((verb) => verb.name).join(", ")}`)
  }
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
