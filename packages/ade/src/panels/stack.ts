/**
 * Several panes of one kind behind one panel name.
 *
 * An agent writes `@ade model state` with no pane id, so every 3D pane
 * answers to "model" and the most recently opened one is the one that does.
 * Registering and unregistering the bare name made closing any pane silence
 * the name for all of them: close the older of two models and the newer one,
 * still on screen, stopped answering. The stack remembers which panes are
 * mounted, in the order they opened, and hands the name back to the newest
 * one left when the answering pane goes.
 *
 * Plain `.ts`, so the order is tested.
 */

import type { PanelHandler, PanelRouter } from "./router"

export interface PanelStack {
  /** A pane of this kind mounted: it answers from now on. */
  push(paneId: string, handler: PanelHandler): void
  /** A pane went away: the newest one left answers, or none. */
  remove(paneId: string): void
}

export function createPanelStack(router: Pick<PanelRouter, "register" | "unregister">, panel: string): PanelStack {
  const mounted: { paneId: string; handler: PanelHandler }[] = []
  return {
    push(paneId, handler) {
      const existing = mounted.findIndex((entry) => entry.paneId === paneId)
      if (existing >= 0) mounted.splice(existing, 1)
      mounted.push({ paneId, handler })
      router.register(panel, handler)
    },
    remove(paneId) {
      const index = mounted.findIndex((entry) => entry.paneId === paneId)
      if (index < 0) return
      const [gone] = mounted.splice(index, 1)
      const top = mounted.at(-1)
      if (top) router.register(panel, top.handler)
      else router.unregister(panel, gone!.handler)
    },
  }
}
