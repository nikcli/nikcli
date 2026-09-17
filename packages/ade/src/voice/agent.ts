/**
 * The voice assistant's agent: what answers a sentence the grammar does not know.
 *
 * It is a coding agent's CLI running one turn per sentence (`bots/turn.ts`),
 * signed in with the user's own account — Claude Code with an Anthropic
 * subscription, Codex with ChatGPT, nikcli with its providers — so a spoken
 * request costs the subscription the user already has, not a key billed per
 * call. The turn gets an `ade-msg` identity, which is what lets it list, ask,
 * start and close ADE's sessions: the same hook every session in a pane has.
 *
 * The decisions — which CLI, what to tell it, when a conversation continues —
 * are pure and tested here; `createVoiceAgent` only holds the conversation and
 * calls the runner.
 */

import type { AgentStatus } from "../session-new/availability"
import { answerSoFar, type RunnerId } from "../bots/runners"
import type { Talk } from "../bots/talk"
import type { TurnRequest, TurnResult } from "../bots/turn"

export type VoiceAgentEngine = "auto" | "claude" | "codex" | "nikcli"

/** Runner id to the catalogue id whose PATH probe says whether it is installed. */
const CATALOGUE_ID: Record<RunnerId, string> = {
  claude: "claude-code",
  codex: "codex",
  nikcli: "nikcli",
}

/**
 * `auto` tries these in order: the subscriptions most users have first.
 *
 * nikcli is not among them. A voice turn must not change the project, and
 * nikcli cannot be told so for one turn (`enforcesDisabledTools`): it would
 * only have the instructions asking it not to.
 */
const AUTO_ORDER: readonly RunnerId[] = ["claude", "codex"]

/**
 * How long a spoken request may take before the turn is stopped.
 *
 * Above the 110 s an `ade-msg ask` waits for its session, so a blocking ask
 * can still come back with an answer; far below the five minutes a turn gets
 * elsewhere, because nobody waits that long for a spoken reply.
 */
export const VOICE_AGENT_TIMEOUT_MS = 150_000

/**
 * The fast setting, per runner: what a spoken answer needs is a short reply
 * soon, and the CLI's default model thinks longer than that.
 */
export const VOICE_AGENT_FAST: Record<RunnerId, { readonly model?: string; readonly effort?: string }> = {
  claude: { model: "claude-sonnet-5", effort: "low" },
  codex: { effort: "low" },
  nikcli: {},
}

/** What a voice turn may not do: edit, write, or run a command other than `ade-msg`. */
export const VOICE_AGENT_DISABLED_TOOLS: readonly string[] = ["edit", "write", "bash"]

/**
 * The runner a request goes to, or why there is none.
 *
 * A named engine is used as asked, installed or not: the turn's own failure
 * ("claude non si avvia") says more than a guess here would. `auto` takes the
 * first one the probe found, and while the probe has not answered it takes the
 * first in order, for the same reason the voice host reports unknown agents as
 * available.
 */
export function resolveVoiceAgentRunner(
  engine: VoiceAgentEngine,
  statuses: readonly AgentStatus[] | undefined,
): { runner: RunnerId } | { problem: string } {
  if (engine === "nikcli") {
    return { problem: "nikcli non può rispondere alla voce in sola lettura: scegli Claude Code o Codex." }
  }
  if (engine !== "auto") return { runner: engine }
  if (!statuses) return { runner: AUTO_ORDER[0] }
  const found = AUTO_ORDER.find(
    (id) => statuses.find((status) => status.agent.id === CATALOGUE_ID[id])?.availability !== "assente",
  )
  return found
    ? { runner: found }
    : { problem: "Per rispondere mi serve Claude Code o Codex, e non ne trovo nessuno installato." }
}

/**
 * Who the agent is, said once per turn as its system prompt.
 *
 * Every line is here because a turn without it went wrong in a specific way:
 * answers are read aloud, so markdown and lists become noise; the turn has no
 * terminal, so an `ade-msg ask` left with `--no-wait` delivers its answer to
 * nobody; and it runs in the user's project, so an agent that edited files
 * itself would be doing, unseen, the work the sessions exist to do in view.
 */
export const VOICE_AGENT_INSTRUCTIONS = [
  "Sei nik, l'assistente vocale di ADE, un ambiente in cui più sessioni di agenti di programmazione lavorano in pannelli affiancati.",
  "Parli con l'utente come un collega: gli dai del tu e parli in prima persona («Chiedo a Prova-voce.», «Ho aperto la sessione.»).",
  "Quello che scrivi viene letto ad alta voce mentre lo scrivi: rispondi in italiano, in una o due frasi brevi, senza markdown, elenchi, codice o percorsi lunghi.",
  "Se ti serve tempo, per esempio per chiedere a una sessione o cercare sul web, scrivi prima una frase brevissima su cosa stai facendo, chiusa da un punto; poi il risultato.",
  "Quando riferisci il lavoro di un'altra sessione, di' il suo nome e il risultato. Chiudi con una domanda solo quando ti serve una decisione.",
  "Se qualcosa non riesce, dillo in parole semplici, senza codici di errore, e di' cosa può fare l'utente.",
  "Per gestire le sessioni usa il comando ade-msg dalla shell:",
  "- ade-msg list: le sessioni aperte;",
  "- ade-msg ask SESSIONE \"RICHIESTA\": chiede e aspetta la risposta; usalo sempre così, bloccante, perché non hai un terminale che riceva risposte dopo;",
  "- ade-msg spawn AGENTE \"COMPITO\" --no-wait: avvia una sessione per un lavoro lungo; poi di' all'utente che è partita, senza aspettarla;",
  "- ade-msg send SESSIONE \"TESTO\": una nota; ade-msg close SESSIONE: chiude una sessione avviata da te.",
  "Non modificare file e non eseguire comandi che cambiano il progetto: il lavoro lo fanno le sessioni, dove l'utente lo vede.",
  "Non puoi aprire pannelli e non scrivere mai righe che iniziano con @ade: qui verrebbero lette ad alta voce. Se l'utente vuole un pannello, digli di dire «apri il browser», «apri il video», «apri il modello 3D», «apri il simulatore» o «apri le decisioni».",
  "Se la richiesta è ambigua, o chiudere o fermare qualcosa farebbe perdere lavoro, chiedi conferma invece di agire.",
].join("\n")

/** What `ask` needs from the app: a runner to call, and what is installed. */
export interface VoiceAgentDeps {
  runTurn: (request: TurnRequest) => { result: Promise<TurnResult>; stop: () => void }
  /**
   * Claude Code kept running between sentences (`bots/warm.ts`). When given,
   * every Claude turn goes there, and the conversation lives in the process.
   */
  warm?: {
    prepare: (request: TurnRequest) => void
    run: (request: TurnRequest) => { result: Promise<TurnResult>; stop: () => void }
    forget: () => void
    close: () => void
  }
  statuses: () => readonly AgentStatus[] | undefined
  cwd: () => string | undefined
}

export interface VoiceAgent {
  /** `ran` is false only when no turn started: see `VoiceHost.askAgent`. */
  ask(request: {
    text: string
    engine: VoiceAgentEngine
    /** `fast` uses `VOICE_AGENT_FAST`; absent or `cli` leaves the CLI's own model. */
    speed?: "fast" | "cli"
    signal?: AbortSignal
    /** The answer so far, each time it grows, so it can be read before it is finished. */
    onText?: (soFar: string) => void
  }): Promise<{ ok: boolean; text: string; ran: boolean }>
  /** Starts the next sentence in a new conversation. */
  forget(): void
  /** Gets the agent ready for a sentence that may come soon. */
  prepare(request: { engine: VoiceAgentEngine; speed?: "fast" | "cli" }): void
  /** Lets go of what `prepare` started: the voice is off. */
  release(): void
}

/**
 * Calls `onText` only when the answer so far has changed. A message that is
 * complete ends with a blank line, so its last sentence is read at once
 * rather than when the turn ends, stop or no stop.
 */
function textFollower(onText: (soFar: string) => void): (talk: Talk) => void {
  let last = ""
  return (talk) => {
    const written = answerSoFar(talk)
    const soFar = written && talk.streaming === undefined ? `${written}\n\n` : written
    if (!soFar || soFar === last) return
    last = soFar
    onText(soFar)
  }
}

export function createVoiceAgent(deps: VoiceAgentDeps): VoiceAgent {
  /*
   * One conversation per runner and project. A follow-up ("e la seconda?")
   * only makes sense to the agent that heard the first question, so the
   * session id is carried over; switching engine or project starts afresh,
   * because the id means nothing to another CLI and the old context would
   * describe the wrong sessions.
   */
  let conversation: { runner: RunnerId; cwd: string | undefined; sessionId: string } | undefined
  /*
   * A new sentence stops the turn still running, and that turn can end after
   * the new one started: only the newest turn may say which conversation
   * comes next.
   */
  let latest = 0

  /* Everything but the sentence: the same for a turn and for the process that waits for one. */
  const turnFor = (runner: RunnerId, cwd: string | undefined, speed: "fast" | "cli" | undefined): Omit<TurnRequest, "message"> => ({
    runner,
    instructions: VOICE_AGENT_INSTRUCTIONS,
    ...(cwd ? { cwd } : {}),
    disabledTools: VOICE_AGENT_DISABLED_TOOLS,
    mailbox: { id: "voce" },
    // No MCP servers or user settings: a spoken answer is worth more than
    // the user's connectors, and loading them tripled the wait.
    lean: true,
    timeoutMs: VOICE_AGENT_TIMEOUT_MS,
    // Always asked for: the warm process is started before anyone listens to it.
    partial: runner === "claude",
    ...(speed === "fast" ? VOICE_AGENT_FAST[runner] : {}),
  })

  return {
    prepare({ engine, speed }) {
      if (!deps.warm) return
      const resolved = resolveVoiceAgentRunner(engine, deps.statuses())
      if ("problem" in resolved || resolved.runner !== "claude") return
      deps.warm.prepare({ ...turnFor("claude", deps.cwd(), speed), message: "" })
    },

    async ask({ text, engine, speed, signal, onText }) {
      const resolved = resolveVoiceAgentRunner(engine, deps.statuses())
      if ("problem" in resolved) return { ok: false, text: resolved.problem, ran: false }

      const generation = ++latest
      const cwd = deps.cwd()
      const warm = resolved.runner === "claude" ? deps.warm : undefined
      const previous =
        !warm && conversation && conversation.runner === resolved.runner && conversation.cwd === cwd
          ? conversation.sessionId
          : undefined

      const request: TurnRequest = {
        ...turnFor(resolved.runner, cwd, speed),
        message: text,
        ...(previous ? { sessionId: previous } : {}),
        ...(onText ? { onUpdate: textFollower(onText) } : {}),
      }
      const turn = warm ? warm.run(request) : deps.runTurn(request)
      const onAbort = () => turn.stop()
      signal?.addEventListener("abort", onAbort, { once: true })
      try {
        const result = await turn.result
        if (result.sessionId && generation === latest) conversation = { runner: resolved.runner, cwd, sessionId: result.sessionId }
        if (result.status === "done") {
          return { ok: true, text: result.text || "Fatto.", ran: true }
        }
        if (result.status === "stopped") return { ok: false, text: "", ran: true }
        return { ok: false, text: result.problem || "Non sono riuscito a risponderti: l'agente non ha detto niente.", ran: true }
      } finally {
        signal?.removeEventListener("abort", onAbort)
      }
    },

    forget() {
      latest++
      conversation = undefined
      deps.warm?.forget()
    },

    release() {
      deps.warm?.close()
    },
  }
}
