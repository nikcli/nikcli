/**
 * Which session a browser pane belongs to.
 *
 * A pane is bound to at most one session: the one working on the site. What
 * the user sends from the inspector goes to that session and to no other;
 * with no binding, or with the bound session not running, the pane asks
 * where to send and remembers the answer. It used to pick the first running
 * session in the grid, which with two agents open was a coin toss.
 *
 * The binding is the session's id plus its title when bound: the id is what
 * a relaunched session keeps, the title is what the chip can still say once
 * the session is gone.
 *
 * Plain `.ts`, so the rules are tested.
 */

import type { PanelOutcome, PanelRequest, PanelVerb } from "../panels/protocol"
import { normalizeUrl } from "./url"

export interface BrowserOwner {
  readonly id: string
  readonly title: string
}

/** A session a pane could be bound to. */
export interface SessionChoice {
  readonly id: string
  readonly title: string
  readonly running: boolean
}

export type OwnerStatus =
  | { readonly state: "none" }
  /** Bound and running: sends go straight to it. */
  | { readonly state: "ready"; readonly id: string; readonly title: string }
  /** Bound, but the session is closed or gone: the next send asks. */
  | { readonly state: "closed"; readonly id: string; readonly title: string }

export function ownerStatus(owner: BrowserOwner | undefined, sessions: readonly SessionChoice[]): OwnerStatus {
  if (!owner) return { state: "none" }
  const live = sessions.find((session) => session.id === owner.id)
  // The session's current title: it may have been renamed since.
  const title = live?.title || owner.title
  return live?.running ? { state: "ready", id: owner.id, title } : { state: "closed", id: owner.id, title }
}

/** The sessions a send can go to: running ones only, a closed one reaches nobody. */
export function bindChoices(sessions: readonly SessionChoice[]): SessionChoice[] {
  return sessions.filter((session) => session.running)
}

export type SendPlan = { readonly kind: "send"; readonly to: string } | { readonly kind: "ask" }

/**
 * Where a send goes: the bound session when it runs, otherwise ask.
 *
 * Never another session on its own: a request meant for the agent building
 * the site, typed into a different agent, is acted on by the wrong one.
 */
export function planSend(status: OwnerStatus): SendPlan {
  return status.state === "ready" ? { kind: "send", to: status.id } : { kind: "ask" }
}

// ---------------------------------------------------------------------------
// `@ade browser …`: a session opens and drives the pane bound to it.

export const BROWSER_VERBS: readonly PanelVerb[] = [
  { name: "open", usage: "open <url>", summary: "apre il sito in un pannello web legato a te, o ci porta il tuo" },
  { name: "reload", usage: "reload", summary: "ricarica il tuo pannello web" },
  { name: "state", usage: "state", summary: "dice indirizzo, modalità, fedeltà e selezione del tuo pannello" },
  { name: "inspect", usage: "inspect on|off", summary: "accende o spegne Ispeziona nel tuo pannello" },
]

/** What a mounted browser pane lets an agent do. */
export interface BrowserController {
  reload(): void
  setInspect(on: boolean): void
  state(): { url: string; inspecting: boolean; fidelity: string; selected: number }
}

export interface BrowserCommandHost {
  /** The session that wrote the request, when it is one ADE runs. */
  session(id: string): BrowserOwner | undefined
  /** The browser pane bound to `ownerId`, the most recent if several. */
  ownedPane(ownerId: string): { id: string; title: string } | undefined
  /** Opens a new pane on `url`, bound to `owner`, in the owner's project. */
  openPane(url: string, owner: BrowserOwner): { id: string; title: string }
  navigate(paneId: string, url: string): void
  /** The pane's controls, when it is on screen. */
  controller(paneId: string): BrowserController | undefined
}

const fail = (reason: string): PanelOutcome => ({ ok: false, reason })
const done = (detail: string): PanelOutcome => ({ ok: true, detail })

export async function runBrowserCommand(
  host: BrowserCommandHost,
  request: PanelRequest,
  from: string | undefined,
): Promise<PanelOutcome> {
  const owner = from ? host.session(from) : undefined
  if (!owner) return fail("solo una sessione di ADE può avere un pannello web")
  const pane = host.ownedPane(owner.id)

  if (request.verb === "open") {
    const url = normalizeUrl(request.args[0] ?? "")
    if (!url) return fail("indirizzo mancante o non valido; es. open http://localhost:5173")
    if (pane) {
      host.navigate(pane.id, url)
      return done(`«${pane.title}» ora mostra ${url}`)
    }
    const opened = host.openPane(url, owner)
    return done(`aperto «${opened.title}» su ${url}, legato a te`)
  }

  if (!BROWSER_VERBS.some((verb) => verb.name === request.verb)) {
    return fail(`comando sconosciuto; disponibili: ${BROWSER_VERBS.map((verb) => verb.name).join(", ")}`)
  }
  if (!pane) return fail("nessun pannello web legato a te; usa open <url>")
  const controller = host.controller(pane.id)
  if (!controller) return fail(`«${pane.title}» non è sullo schermo ora (è in un altro progetto?)`)

  switch (request.verb) {
    case "reload":
      controller.reload()
      return done(`«${pane.title}» ricaricato`)
    case "inspect": {
      const arg = (request.args[0] ?? "").toLowerCase()
      if (arg !== "on" && arg !== "off") return fail("scrivi inspect on oppure inspect off")
      controller.setInspect(arg === "on")
      return done(arg === "on" ? "Ispeziona acceso: l'utente può selezionare elementi" : "Ispeziona spento")
    }
    default: {
      const state = controller.state()
      const mode = state.inspecting ? "Ispeziona" : "Naviga"
      return done(`${state.url} — ${mode}, ${state.fidelity}, ${state.selected} elementi selezionati`)
    }
  }
}
