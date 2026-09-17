import type { PaneSummary, VoiceHost, VoiceStateSnapshot } from "@nikcli-ai/voice/core"
import type { Host, SpawnedSession } from "../host/shell"
import type { Project } from "../host/project"
import type { RecentEntry } from "../host/recent"
import type { PermissionAnswer, PermissionRequest } from "../session/permission"
import { AGENTS } from "../session-new/agents"
import type { AgentStatus } from "../session-new/availability"
import { asOneLine, asSubmittedLine } from "../session/typing"
import { findByName } from "../search/find"
import { walkProject } from "../search/walk"
import {
  VISIBLE_VIEWS,
  isPanelPane,
  reachableView,
  setColumns as updateColumns,
  updatePane,
  type AdeView,
  type Workbench as WorkbenchState,
} from "../surface/state"
import { awaitPaneReply } from "./await-reply"
import { createVoiceAgent, type VoiceAgent } from "./agent"
import { listProjectsFrom, resolveAgentId, resolveProject } from "./resolve"

/**
 * External dependencies provided by Workbench to avoid direct global state coupling.
 */
export interface AdeVoiceHostDeps {
  wb: () => WorkbenchState
  setWb: (updater: (prev: WorkbenchState) => WorkbenchState) => void
  project: () => Project | undefined
  runCommand: (id: string) => Promise<void>
  isRunning: (paneId: string) => boolean
  getRunningSession: (
    paneId: string,
  ) => SpawnedSession | { write: (text: string) => void; kill?: () => void } | undefined
  openFile: (path: string) => Promise<void>
  appendLine: (paneId: string, text: string, kind?: "step" | "shell" | "note") => void
  permissions: () => Record<string, PermissionRequest>
  answerPermission: (paneId: string, answer: PermissionAnswer) => void
  getHost?: () => Promise<Host | undefined>
  scrollTranscript?: (paneId: string, delta: number) => void
  /** The MRU project list, so a plan can name a project ADE is not in. */
  recents?: () => readonly RecentEntry[]
  /**
   * What the PATH probe found, once it has answered.
   *
   * Undefined while it is still running — reported as available rather than
   * absent, see `listAgents`.
   */
  agentAvailability?: () => AgentStatus[] | undefined
  /** Opens a project already on disk, keeping the panes of the one being left. */
  switchProject?: (root: string) => Promise<void>
  /**
   * Creates one pane and starts one agent in it, returning the pane it made.
   *
   * The workbench owns pane creation — the id, the title, the placement and
   * the process — and hands the result back rather than letting a second
   * implementation of it grow here.
   */
  openAgentSession?: (input: { agentId: string; task: string }) => { paneId: string; title: string }
}

const ITALIAN_NUMBERS: Record<number, string> = {
  0: "zero",
  1: "una",
  2: "due",
  3: "tre",
  4: "quattro",
  5: "cinque",
  6: "sei",
  7: "sette",
  8: "otto",
  9: "nove",
  10: "dieci",
}

/**
 * The rendered element of one pane, found by its own id.
 *
 * Voice reaches the composer and the transcript through the DOM because both
 * are uncontrolled — the pane owns them. Matching on the id rather than on
 * position keeps dictation on the session the user actually named, even after
 * a pane in front of it is closed.
 */
function paneElement(paneId: string): HTMLElement | null {
  if (typeof document === "undefined") return null
  return document.querySelector<HTMLElement>(`[data-component="session-pane"][data-pane-id="${CSS.escape(paneId)}"]`)
}

/**
 * Creates an implementation of VoiceHost wired to the ADE Workbench.
 */
/** Commands whose result is a pane or the launch form, both shown only in the Code view. */
const OPENS_IN_GRID = new Set(["session.new", "browser.new", "video.new", "model.new", "app.new", "pane.expand"])

/** How long a warm agent waits for the project before starting without one. */
const PREPARE_WAIT_MS = 30_000

export function createAdeVoiceHost(deps: AdeVoiceHostDeps): VoiceHost {
  /*
   * The agent that answers what the grammar cannot, built on first use.
   *
   * Imported lazily: `bots/turn` reaches the native host, and the voice host
   * is also built by tests and the browser harness, where no sentence ever
   * gets that far.
   */
  let agent: Promise<VoiceAgent> | undefined
  /* Closed with the window: a process left waiting would outlive the app until its idle timer. */
  const warmClaude = <T extends { close: () => void }>(warm: T): T => {
    if (typeof window !== "undefined") window.addEventListener("pagehide", () => warm.close())
    return warm
  }
  const voiceAgent = () =>
    (agent ??= Promise.all([import("../bots/turn"), import("../bots/warm")]).then(
      ([{ runTurn }, { createWarmClaude }]) =>
        createVoiceAgent({
          runTurn,
          warm: warmClaude(createWarmClaude()),
          statuses: () => deps.agentAvailability?.(),
          cwd: () => deps.project()?.root,
        }),
    ))

  return {
    async askAgent(request) {
      return (await voiceAgent()).ask(request)
    },

    prepareAgent(request) {
      /*
       * At start-up the project may not be open yet, and a process started
       * without it would be replaced at the first sentence. Waited for, up to
       * half a minute, then started where the turn will run.
       */
      void (async () => {
        for (let waited = 0; !deps.project()?.root && waited < PREPARE_WAIT_MS; waited += 500) {
          await new Promise((resolve) => setTimeout(resolve, 500))
        }
        ;(await voiceAgent()).prepare(request)
      })()
    },

    releaseAgent() {
      void agent?.then((ready) => ready.release())
    },

    async runCommand(id: string): Promise<void> {
      /*
       * What these open lives in the grid, and the grid is only on screen in
       * the Code view. Said from the Agent view, where the voice console is,
       * «apri il browser» answered «aperto» and the user saw nothing change.
       */
      if (OPENS_IN_GRID.has(id) && deps.wb().view !== "code") deps.setWb((w) => ({ ...w, view: "code" }))
      await deps.runCommand(id)
    },

    listPanes(): PaneSummary[] {
      return deps.wb().panes.map((pane, index) => ({
        id: pane.id,
        title: pane.title,
        status: pane.status,
        index: index + 1,
        hasLiveProcess: deps.isRunning(pane.id),
        isBrowser: Boolean(pane.browserUrl),
        isFile: Boolean(pane.filePath),
      }))
    },

    /*
     * The catalogue as it is, not as a planner imagines it.
     *
     * Every entry ADE knows how to start is listed, including the ones this
     * machine has not installed: an agent that is present and one that is
     * missing are both better answers than an agent that is absent from the
     * list, which reads to the planner as "that word means nothing".
     */
    listAgents(): { id: string; label: string; available: boolean }[] {
      const statuses = deps.agentAvailability?.()
      return AGENTS.map((agent) => {
        const found = statuses?.find((status) => status.agent.id === agent.id)?.availability
        /*
         * Unknown counts as available. The probe may not have answered yet, or
         * there may be no host to probe with (the browser harness) — in both
         * cases claiming the agent is missing would be inventing a refusal out
         * of ignorance, and the user would be told to install something they
         * already have. A start that fails says so for itself.
         */
        return { id: agent.id, label: agent.label, available: found !== "assente" }
      })
    },

    listProjects(): { name: string; root: string; isOpen: boolean }[] {
      return listProjectsFrom(deps.recents?.() ?? [], deps.project())
    },

    /**
     * Opens one session, on one task, in one project.
     *
     * One call, one pane: "quattro sessioni, una sul parser, una sui test" is
     * four calls with four tasks, which is why there is no count here. The
     * pane id comes back so the planner can keep talking to the session it
     * just made instead of guessing which of four panes is which.
     */
    async startSession(input: {
      agent: string
      task?: string
      project?: string
    }): Promise<{ paneId: string; title: string }> {
      // Resolved before anything is opened: refusing an unknown agent must not
      // cost the user a project switch they did not ask for.
      const agentId = resolveAgentId(input.agent, AGENTS)

      if (input.project) {
        const target = resolveProject(input.project, listProjectsFrom(deps.recents?.() ?? [], deps.project()))
        if (!target.isOpen) {
          if (!deps.switchProject) {
            throw new Error(`Non posso passare al progetto «${target.name}» da qui: aprilo tu e ripeti.`)
          }
          // Awaited, because the new session's working directory is whatever
          // project is open when the process spawns.
          await deps.switchProject(target.root)
        }
      }

      /*
       * A session needs somewhere to run.
       *
       * `startProcess` gives up silently without an open project, which from
       * here would look like a success: a pane stuck on "Inizializzazione" and
       * an assistant saying it started. Better to ask which project.
       */
      if (!deps.project()) {
        throw new Error("Non c'è nessun progetto aperto: dimmi in quale progetto avviare la sessione.")
      }

      if (!deps.openAgentSession) {
        throw new Error("Non posso avviare sessioni da qui.")
      }
      return deps.openAgentSession({ agentId, task: input.task?.trim() ?? "" })
    },

    focusPane(paneId: string): void {
      deps.setWb((w) => ({ ...w, focusedId: paneId }))
    },

    async sendPrompt(paneId: string, text: string): Promise<void> {
      if (!deps.isRunning(paneId)) {
        throw new Error(`Il pannello '${paneId}' non ha un processo vivo a cui inviare il messaggio.`)
      }
      const session = deps.getRunningSession(paneId)
      if (!session) {
        throw new Error(`Nessuna sessione attiva per il pannello '${paneId}'.`)
      }
      /*
       * One line, and submitted.
       *
       * The transcript below already shows the message as sent, so it has to
       * actually be sent: without the terminator the words sat in the agent's
       * input line, unprocessed, while the user watched their own message
       * appear and waited for an answer that was never going to come. And
       * `replace(/\n/g, " ")` left carriage returns alone, which a tty reads
       * as Enter — one dictated sentence could arrive as two submissions.
       */
      const singleLine = asOneLine(text)
      deps.setWb((w) => updatePane(w, paneId, { status: "working", activity: "running" }))
      deps.appendLine(paneId, `> ${singleLine}`, "shell")
      session.write(asSubmittedLine(singleLine))
    },

    /*
     * Watching a pane is the only way to know an answer arrived: a pty emits
     * lines, not events, and the pane's status is unreliable for agents that
     * redraw forever. `awaitPaneReply` decides "finished" the way a person
     * watching would — the output stopped and stayed stopped — and the rules
     * for that live in their own module so they can be tested against a
     * scripted transcript instead of a real agent.
     */
    async awaitReply(paneId: string, options?: { signal?: AbortSignal }) {
      return awaitPaneReply(
        {
          linesOf: (id) => deps.wb().panes.find((pane) => pane.id === id)?.lines,
          statusOf: (id) => deps.wb().panes.find((pane) => pane.id === id)?.status,
          now: () => Date.now(),
          sleep: (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
        },
        paneId,
        options,
      )
    },

    async openFile(path: string): Promise<void> {
      await deps.openFile(path)
    },

    async searchProject(query: string): Promise<{ path: string; line?: number }[]> {
      if (!deps.getHost) {
        return []
      }
      const host = await deps.getHost()
      const current = deps.project()
      // Thrown, not answered with an empty list: «0 risultati» and a search
      // that could not run are different things to the person who asked.
      if (!host) throw new Error("la ricerca nel progetto funziona solo nell'app desktop")
      if (!current) throw new Error("non c'è nessun progetto aperto in cui cercare")
      try {
        const result = await walkProject({ host, root: current.root })
        const hits = findByName(result.files, query, 40)
        return hits.map((hit) => ({ path: hit.path }))
      } catch (error) {
        throw new Error(
          `non riesco a leggere i file del progetto (${error instanceof Error ? error.message : String(error)})`,
        )
      }
    },

    /*
     * The pane no longer has a diff face: the "modifiche" tab was removed from
     * the session pane, so there is nothing to switch to. The method stays
     * because `VoiceHost` (packages/voice) still declares it.
     */
    setPaneView(): boolean {
      return false
    },

    browserNavigate(paneId: string, url: string): boolean {
      if (!deps.wb().panes.some((pane) => pane.id === paneId)) return false
      deps.setWb((w) => updatePane(w, paneId, { browserUrl: url }))
      return true
    },

    answerPermission(paneId: string, answer: "allow" | "deny"): boolean {
      const pending = deps.permissions()[paneId]
      if (!pending) {
        return false
      }

      let chosen: PermissionAnswer | undefined
      if (answer === "allow") {
        chosen =
          pending.answers.find(
            (a) =>
              a.tone === "primary" ||
              /^(?:sì|si|consenti|allow|yes|accetta|procedi|conferma)/i.test(a.label) ||
              a.send.toLowerCase() === "y",
          ) ?? pending.answers[0]
      } else {
        /*
         * No fallback, on purpose.
         *
         * This used to end with `?? pending.answers[1]` — the second option,
         * whatever it happened to be. On a question whose options are "Allow
         * once" and "Allow always", both permissive, saying "nega" out loud
         * granted the permission permanently. A refusal that can grant is the
         * one failure this path must not have, so when nothing reads as a
         * refusal nothing is sent and the request stays on screen for the
         * user to answer by hand.
         */
        chosen = pending.answers.find(
          (a) =>
            /^(?:no|nega|rifiuta|deny|reject|annulla|cancel)/i.test(a.label) ||
            /^(?:n|no)$/i.test(a.send.trim().toLowerCase()),
        )
      }

      if (chosen) {
        deps.answerPermission(paneId, chosen)
        return true
      }

      if (answer === "deny") {
        deps.appendLine(
          paneId,
          "Nessuna delle risposte proposte è un rifiuto: rispondi tu, non scelgo al posto tuo.",
          "note",
        )
      }
      return false
    },

    setColumns(columns?: number): void {
      deps.setWb((w) => updateColumns(w, columns))
    },

    setView(view: AdeView): void {
      // Chat and Bot may be hidden (S40); the dispatcher asks first, this is the backstop.
      deps.setWb((w) => ({ ...w, view: reachableView(view) }))
    },

    availableViews(): readonly AdeView[] {
      return VISIBLE_VIEWS
    },

    scrollTranscript(paneId: string, delta: number): void {
      if (deps.scrollTranscript) {
        deps.scrollTranscript(paneId, delta)
        return
      }
      const target = paneElement(paneId)?.querySelector('[data-slot="pane-transcript"]')
      if (target) {
        target.scrollTop += delta
      }
    },

    /**
     * Put dictated text where the user can still read it before it is sent.
     *
     * Two places, because a pane has at most one of them. A pane with no live
     * terminal shows the composer: an uncontrolled textarea that owns its own
     * value, so this writes to the element and fires an `input` event — the
     * same signal a keystroke sends, which is what makes the box grow to fit
     * what was said. Existing text is kept: dictation adds to a sentence, it
     * does not replace it.
     *
     * A pane with a live terminal has no composer at all — the emulator is the
     * input, and a second one under it was costing every tile a row. There the
     * dictated words go to the pty with no terminator, exactly as the browser
     * pane's "send to agent" does: the text lands on the agent's input line and
     * the user presses Enter themselves. That distinction is the whole contract
     * of `insertText` against `sendPrompt`, and it survives either route.
     */
    async insertText(paneId: string, text: string): Promise<void> {
      const trimmed = asOneLine(text).trim()
      if (trimmed.length === 0) return

      const field = paneElement(paneId)?.querySelector<HTMLTextAreaElement>('[data-slot="pane-prompt"] textarea')

      if (field && !field.disabled) {
        const existing = field.value
        field.value =
          existing.length > 0 && !existing.endsWith(" ") ? `${existing} ${trimmed}` : `${existing}${trimmed}`
        field.dispatchEvent(new Event("input", { bubbles: true }))
        field.focus()
        return
      }

      const session = deps.getRunningSession(paneId)
      if (!session) {
        throw new Error(
          field
            ? "Il pannello selezionato non ha un processo in ascolto."
            : "Il pannello selezionato non ha dove ricevere il testo.",
        )
      }
      // A trailing space, not a carriage return: the next dictated phrase must
      // not run into this one, and nothing is submitted until the user says so.
      session.write(`${trimmed} `)
    },

    describeState(): VoiceStateSnapshot {
      const panes = this.listPanes()
      /*
       * A session is an agent's terminal. The browser, a file, the video, 3D,
       * simulator and decisions panels and a plugin's tile are all panes, and
       * counting them said «ci sono tre sessioni» to someone with one session
       * and two panels open. `isPanelPane` is the same question the sidebar
       * and the restore ask, and it knows about the panel modes as well.
       */
      const sessionIds = new Set(
        deps
          .wb()
          .panes.filter((pane) => !isPanelPane(pane))
          .map((pane) => pane.id),
      )
      const sessionPanes = panes.filter((p) => sessionIds.has(p.id))
      const totalSessions = sessionPanes.length
      const workingSessions = sessionPanes.filter((p) => p.status === "working" || p.status === "provisioning").length
      const waitingSessions = sessionPanes.filter((p) => p.status === "waiting").length
      const doneSessions = sessionPanes.filter((p) => p.status === "done").length
      const errorSessions = sessionPanes.filter((p) => p.status === "error").length

      const focusedPane = panes.find((p) => p.id === deps.wb().focusedId)
      const activeProject = deps.project()?.name ?? deps.wb().projectPath
      const currentView = deps.wb().view

      let spokenSummary: string
      if (totalSessions === 0) {
        spokenSummary = "Al momento non c'è nessuna sessione aperta."
      } else if (totalSessions === 1) {
        const detail =
          workingSessions > 0
            ? " in esecuzione"
            : waitingSessions > 0
              ? " in attesa"
              : doneSessions > 0
                ? " completata"
                : errorSessions > 0
                  ? " in errore"
                  : ""
        spokenSummary = `C'è una sessione${detail}.`
      } else {
        const countWord = ITALIAN_NUMBERS[totalSessions] ?? String(totalSessions)
        const details: string[] = []
        if (workingSessions > 0) {
          details.push(
            `${workingSessions === 1 ? "una" : (ITALIAN_NUMBERS[workingSessions] ?? workingSessions)} in esecuzione`,
          )
        }
        if (waitingSessions > 0) {
          details.push(
            `${waitingSessions === 1 ? "una" : (ITALIAN_NUMBERS[waitingSessions] ?? waitingSessions)} in attesa`,
          )
        }
        if (doneSessions > 0) {
          const w =
            doneSessions === 1 ? "una completata" : `${ITALIAN_NUMBERS[doneSessions] ?? doneSessions} completate`
          details.push(w)
        }
        if (errorSessions > 0) {
          details.push(`${errorSessions === 1 ? "una" : (ITALIAN_NUMBERS[errorSessions] ?? errorSessions)} in errore`)
        }
        const detailsStr = details.length > 0 ? `: ${details.join(", ")}.` : "."
        spokenSummary = `Ci sono ${countWord} sessioni${detailsStr}`
      }

      return {
        totalSessions,
        workingSessions,
        waitingSessions,
        doneSessions,
        errorSessions,
        focusedPane,
        activeProject,
        currentView,
        spokenSummary,
      }
    },
  }
}
