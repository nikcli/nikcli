/**
 * Turning a sentence the grammar could not match into a plan.
 *
 * The hand-written vocabulary (`intent/parse.ts`) handles what people say
 * often, instantly and offline. It cannot handle "avvia quattro sessioni
 * claude nel progetto nikcli, una sul parser e una sui test", and no list of
 * phrases ever will: the count, the agent, the project and one free-text task
 * per session are four open dimensions at once.
 *
 * So this is the second half of a hybrid. It runs only on the utterances the
 * grammar rejected, which keeps the common case free of a network round trip,
 * and everything it produces goes through `validatePlan` before it can touch
 * the host — the model proposes, it does not decide.
 */

import { MAX_PLAN_STEPS, validatePlan, type PlanContext, type ValidatedPlan } from "./schema"

export const PLANNER_ENDPOINT = "https://openrouter.ai/api/v1/chat/completions"

/**
 * A small, fast model, because this is a translation job and not a reasoning
 * one: the whole task is to restate one sentence as a list of four fields.
 * Latency is the thing the user feels — they are standing there waiting to be
 * answered — so this is chosen for speed and can be overridden.
 */
export const PLANNER_MODEL = "google/gemini-2.5-flash"

export const PLANNER_TIMEOUT_MS = 15_000

/** The one call this module needs, injected so tests never touch the network. */
export type Completion = (prompt: { system: string; user: string; signal?: AbortSignal }) => Promise<string>

export interface PlannerResult extends ValidatedPlan {
  /**
   * Why nothing could be planned, when that is the outcome — a missing key, a
   * refused request, an unreachable network. Separate from `refusals`, which
   * is about steps that were understood and rejected; this is about not
   * having got an answer at all, and the user is told different things.
   */
  failure?: string
}

/**
 * Describes this installation to the model, then asks for JSON.
 *
 * The context is not decoration: without the real agent ids and project names
 * the model invents plausible ones, and `validatePlan` then refuses a plan
 * that was only ever wrong because nobody told the model what existed.
 */
export function buildPlannerPrompt(
  utterance: string,
  context: PlanContext,
): {
  system: string
  user: string
} {
  const agents = context.agents
    .map((agent) => `- ${agent.id} (${agent.label})${agent.available ? "" : " — NON installato"}`)
    .join("\n")
  const projects = context.projects
    .map((project) => `- ${project.name}${project.isOpen ? " (aperto ora)" : ""}`)
    .join("\n")

  const historyLines =
    context.recentHistory && context.recentHistory.length > 0
      ? [
          "",
          "Cronologia recente della conversazione:",
          ...context.recentHistory.map((h) => `- ${h.role === "user" ? "Utente" : "Jarvis"}: ${h.text}`),
        ]
      : []

  const system = [
    "Sei JARVIS, l'assistente vocale intelligente e compagno di pair programming dentro NIK ADE.",
    "Comprendi la voce dell'utente in italiano e rispondi con un oggetto JSON nella forma:",
    '{"speech":"<tua risposta parlata in italiano>","steps":[<eventuali operazioni su ADE>]}',
    "Nessun testo attorno, nessun commento oltre al JSON.",
    "",
    "Regole per 'speech':",
    "- Rispondi in italiano naturale, tecnico, conciso e professionale (tono Jarvis).",
    "- Massimo 1-3 frasi chiare ad alta densità: l'utente ascolta la sintesi vocale e non vuole monologhi.",
    "- Non tradurre termini tecnici standard come commit, branch, build, test, pane, terminal, debug, pull request.",
    "- Se l'utente chiede spiegazioni, consigli di programmazione o informazioni sullo stato, rispondi con precisione in `speech` con `steps: []`.",
    "- Se l'utente chiede operazioni su ADE, conferma brevemente in `speech` (es. 'Avvio subito Claude sul progetto nikcli.') e compila `steps`.",
    "",
    "Operazioni ammesse in 'steps' (lascia [] se la richiesta è puramente informativa o discorsiva):",
    '{"action":"start_session","agent":"<id>","task":"<cosa deve fare>","project":"<nome>"}',
    '{"action":"open_project","project":"<nome>"}',
    '{"action":"run_command","command":"<id>"}',
    '{"action":"focus_pane","paneIndex":<n>}',
    '{"action":"send_prompt","paneIndex":<n>,"text":"<messaggio>"}',
    "",
    "Regole operative:",
    `- Al massimo ${MAX_PLAN_STEPS} operazioni in steps.`,
    "- Più sessioni diverse sono più operazioni start_session distinte.",
    "- `task` è il compito in italiano. Se non indicato, ometti il campo.",
    "- Usa solo gli id elencati sotto. Non inventare agenti, progetti o comandi.",
    "- Non esistono operazioni per chiudere pannelli o terminare processi: rimangono al controllo manuale o alla grammatica fissa.",
    "",
    "Agenti disponibili:",
    agents || "- (nessuno)",
    "",
    "Progetti:",
    projects || "- (nessuno)",
    "",
    `Pannelli aperti: ${context.paneCount}${context.focusedPaneTitle ? ` (a fuoco: "${context.focusedPaneTitle}")` : ""}`,
    context.activeProjectName ? `Progetto attivo: ${context.activeProjectName}` : "",
    "",
    "Comandi:",
    context.commands.length ? context.commands.map((id) => `- ${id}`).join("\n") : "- (nessuno)",
    ...historyLines,
  ].filter(Boolean).join("\n")

  return { system, user: utterance }
}

/**
 * Pulls the JSON out of a model's answer.
 *
 * Handles both JSON arrays `[...]` and JSON objects `{...}`, with or without
 * markdown code fences or conversational prefaces.
 */
export function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  const body = (fenced ? fenced[1] : text).trim()

  const direct = tryParse(body)
  if (direct !== undefined) return direct

  // Check whichever outermost delimiter appears first in the string
  const arrStart = body.indexOf("[")
  const objStart = body.indexOf("{")

  if (arrStart !== -1 && (objStart === -1 || arrStart < objStart)) {
    const arrEnd = body.lastIndexOf("]")
    if (arrEnd > arrStart) {
      const span = tryParse(body.slice(arrStart, arrEnd + 1))
      if (span !== undefined) return span
    }
  }

  if (objStart !== -1) {
    const objEnd = body.lastIndexOf("}")
    if (objEnd > objStart) {
      const span = tryParse(body.slice(objStart, objEnd + 1))
      if (span !== undefined) return span
    }
  }

  // Fallback: check array if object check was skipped or failed
  if (arrStart !== -1) {
    const arrEnd = body.lastIndexOf("]")
    if (arrEnd > arrStart) {
      const span = tryParse(body.slice(arrStart, arrEnd + 1))
      if (span !== undefined) return span
    }
  }

  return undefined
}

function tryParse(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/**
 * Plans one utterance. Never throws: every failure becomes something to say.
 */
export async function planUtterance(
  utterance: string,
  context: PlanContext,
  complete: Completion,
  options: { signal?: AbortSignal } = {},
): Promise<PlannerResult> {
  const prompt = buildPlannerPrompt(utterance, context)

  let answer: string
  try {
    answer = await complete({ ...prompt, signal: options.signal })
  } catch (error) {
    return {
      steps: [],
      refusals: [],
      failure: error instanceof Error ? error.message : "Non sono riuscito a interpretare la frase.",
    }
  }

  const raw = extractJson(answer)
  if (raw === undefined) {
    return { steps: [], refusals: [], failure: "Non ho capito cosa fare con quella frase." }
  }

  /*
   * An empty array is the model saying "questa frase non chiede niente" —
   * which the system prompt asks for explicitly. It is a valid answer, not a
   * failure, and treating it as one would turn every stray word picked up by
   * the microphone into an error message.
   */
  return validatePlan(raw, context)
}

/**
 * The OpenRouter-backed completion.
 *
 * Deliberately thin: it is the only part of this file that cannot be tested
 * without a network, so it holds nothing but the request.
 */
export function createOpenRouterCompletion(input: {
  apiKey: string
  model?: string
  fetchFn?: typeof fetch
  timeoutMs?: number
}): Completion {
  const fetchFn = input.fetchFn ?? fetch
  const model = input.model ?? PLANNER_MODEL
  const timeoutMs = input.timeoutMs ?? PLANNER_TIMEOUT_MS

  return async ({ system, user, signal }) => {
    if (!input.apiKey) {
      throw new Error("Manca la chiave OpenRouter: aggiungila nelle impostazioni della voce.")
    }

    /*
     * A timeout of its own, joined with the caller's abort. Without it a
     * hanging request leaves the assistant silent with no ceiling, which from
     * the outside is identical to being broken.
     */
    const timer = AbortSignal.timeout(timeoutMs)
    const abort = signal ? AbortSignal.any([signal, timer]) : timer

    const response = await fetchFn(PLANNER_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${input.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        // Zero, because two identical sentences must produce the same plan.
        // Sampling here buys nothing and costs reproducibility.
        temperature: 0,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      }),
      signal: abort,
    })

    if (!response.ok) {
      throw new Error(`Il servizio ha risposto ${response.status}.`)
    }

    const body = (await response.json()) as {
      choices?: { message?: { content?: unknown } }[]
    }
    const content = body.choices?.[0]?.message?.content
    if (typeof content !== "string") {
      throw new Error("Risposta del servizio in un formato inatteso.")
    }
    return content
  }
}
