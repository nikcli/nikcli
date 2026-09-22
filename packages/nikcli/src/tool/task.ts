import { Tool } from "./tool"
import DESCRIPTION from "./task.txt"
import z from "zod"
import { Session } from "../session"
import { Bus } from "../bus"
import { MessageV2 } from "../session/message-v2"
import { Identifier } from "@nikcli-ai/util/id"
import { Agent } from "../agent/agent"
import { SessionPrompt } from "../session/prompt"
import { iife } from "@nikcli-ai/util/iife"
import { defer } from "@nikcli-ai/util/defer"
import { Config } from "../config/config"
import { Provider } from "../provider/provider"
import { PermissionNext } from "@/permission/next"
import { Delegation } from "@/delegation/manager"
import { BackgroundRun } from "@/background/run"
import { Instance } from "../project/instance"
import { Log } from "@nikcli-ai/util/log"
import { Effect } from "effect"
import { runPromiseWithLayer, withCurrentInstance } from "@/effect"
import { Semaphore } from "@/util/queue"
import { throttleTrailing } from "@/util/throttle"

// Background delegations run in-process as concurrent agent loops (LLM calls +
// tool execution). Without a bound, a fan-out of subtasks pins the CPU. Cap the
// number of heavy agent loops (workers, delegators and follow-ups) that run at
// once; the rest queue and start as permits free up.
const MAX_CONCURRENT_BACKGROUND_AGENTS = 5
const backgroundAgentLimit = new Semaphore(MAX_CONCURRENT_BACKGROUND_AGENTS)

// PartUpdated fires once per streaming token. Coalesce the side effects it
// drives (progress persistence, live metadata) so they run on a time budget
// instead of per token.
const PROGRESS_WRITE_THROTTLE_MS = 1000
const FOREGROUND_METADATA_THROTTLE_MS = 200

const parameters = z.object({
  description: z.string().describe("A short (3-5 words) description of the task"),
  prompt: z.string().describe("The task for the agent to perform"),
  subagent_type: z.string().describe("The type of specialized agent to use for this task"),
  model: z
    .string()
    .describe(
      "Optional model for the subagent, taken from the user's own words: pass whatever they called it, or a full \"providerID/modelID\" when you have one. It is matched against the models this instance can actually reach; a name that fits none, or that fits several variants, comes back with those models listed so you can call again with an exact one. Omit it unless the user asked for a specific model; it then defaults to the agent's own model, else this session's.",
    )
    .optional(),
  background: z.boolean().describe("Run the subagent in background and return immediately").optional().default(true),
  session_id: z.string().describe("Existing Task session to continue").optional(),
  command: z.string().describe("The command that triggered this task").optional(),
})

function configGet() {
  return runPromiseWithLayer(
    Config.defaultLayer,
    withCurrentInstance(
      Effect.gen(function* () {
        const config = yield* Config.Service
        return yield* config.get()
      }),
    ),
  )
}

function runSessionPrompt<A, E>(effect: Effect.Effect<A, E, SessionPrompt.Service>) {
  return runPromiseWithLayer(SessionPrompt.defaultLayer, withCurrentInstance(effect))
}

function runSession<A, E>(effect: Effect.Effect<A, E, Session.Service>) {
  return runPromiseWithLayer(Session.defaultLayer, withCurrentInstance(effect))
}

export type TaskParams = z.infer<typeof parameters>

type ToolSummaryItem = {
  id: string
  tool: string
  state: { status: string; title?: string }
}

type TaskMetadata = {
  summary?: ToolSummaryItem[]
  sessionId: string
  /** Set only when the caller overrode the model, as "providerID/modelID". */
  model?: string
  jobId?: string
  rootDelegationId?: string
  delegationId?: string
  delegatorDelegationId?: string
  delegatorSessionId?: string
  background?: boolean
  liveSummary?: string
  kind?: string
  question?: string
  sourceCount?: number
  confidence?: string
  followUpRounds?: number
  reused?: boolean
}

type PrimaryToolsConfig = NonNullable<Config.Info["experimental"]>["primary_tools"]

type BackgroundTaskResult = {
  jobId: string
  rootDelegationId: string
  delegationId: string
  delegatorDelegationId: string
  delegatorSessionId: string
  sessionId: string
  kind?: string
  question?: string
  sourceCount?: number
  confidence?: string
  followUpRounds?: number
  reused?: boolean
}

type ResearchRunMetadata = {
  kind: "research"
  question?: string
  sourceCount?: number
  confidence?: string
  followUpRounds?: number
}

const RESEARCH_AGENT = "researcher"
const log = Log.create({ service: "task" })

function agentGet(name: string) {
  return runPromiseWithLayer(
    Agent.defaultLayer,
    withCurrentInstance(
      Effect.gen(function* () {
        const agent = yield* Agent.Service
        return yield* agent.get(name)
      }),
    ),
  )
}

function agentList() {
  return runPromiseWithLayer(
    Agent.defaultLayer,
    withCurrentInstance(
      Effect.gen(function* () {
        const agent = yield* Agent.Service
        return yield* agent.list()
      }),
    ),
  )
}

function providerList() {
  return runPromiseWithLayer(
    Provider.defaultLayer,
    withCurrentInstance(
      Effect.gen(function* () {
        const provider = yield* Provider.Service
        return yield* provider.list()
      }),
    ),
  )
}

/** An id and its display name collapse to the same haystack: case, spaces,
 * dots and dashes all drop out. */
function normalizeModelQuery(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "")
}

export type ModelCandidate = {
  providerID: string
  modelID: string
  name: string
  releaseDate: string
}

/** Alphanumeric runs of a query, the units a catalog entry can share with it. */
function modelQueryTokens(value: string) {
  return value.toLowerCase().match(/[a-z0-9]+/g) ?? []
}

/**
 * The failure a caller can act on: a catalog of a few hundred models truncated
 * to its first entries teaches nothing, so lead with the ones that share the
 * most with what was asked for, and say how many were left out.
 */
function unmatchedModelError(raw: string, candidates: ModelCandidate[], needle: string) {
  const SHOWN = 20
  const tokens = modelQueryTokens(raw)
  const ranked = candidates
    .map((candidate) => {
      const haystack = normalizeModelQuery(`${candidate.providerID}/${candidate.modelID} ${candidate.name}`)
      const score = tokens.filter((token) => haystack.includes(token)).length + (haystack.includes(needle) ? 1 : 0)
      return { ref: `${candidate.providerID}/${candidate.modelID}`, score }
    })
    .sort((a, b) => b.score - a.score || a.ref.localeCompare(b.ref))
  const closest = ranked.some((entry) => entry.score > 0)
    ? ranked.filter((entry) => entry.score > 0).slice(0, SHOWN)
    : ranked.slice(0, SHOWN)
  const rest = candidates.length - closest.length
  return new Error(
    `No model matches "${raw}". Closest of ${candidates.length} available: ${closest
      .map((entry) => entry.ref)
      .join(", ")}${rest > 0 ? `, and ${rest} more` : ""}`,
  )
}

/**
 * Pick the model a free-form `model` parameter refers to, or throw with the
 * models it could have meant.
 *
 * Nothing about any model is known here: the vocabulary is whatever the
 * instance's provider catalog contains. The caller is a model relaying what
 * the user wrote — an exact `"providerID/modelID"`, or just the words they
 * used — so match on id and display name alike.
 *
 * What it will not do is guess between near-identical variants. Catalogs
 * routinely carry a dozen entries per family, and several of them stamp every
 * model with the same placeholder release date, so "newest wins" quietly
 * degrades into "alphabetically first wins". When a fragment still fits more
 * than one model, the error lists them and the caller picks; a wrong model
 * costs more than a second tool call.
 *
 * Exported for tests; production callers go through `resolveSubagentModel`.
 */
export function selectSubagentModel(candidates: ModelCandidate[], raw: string, preferProviderID: string) {
  const query = raw.trim()
  if (!query) throw new Error("model must not be empty")

  const parsed = query.includes("/") ? Provider.parseModel(query) : undefined
  if (parsed) {
    const exact = candidates.find((c) => c.providerID === parsed.providerID && c.modelID === parsed.modelID)
    if (exact) return ref(exact)
  }

  // A "<provider>/<words>" query narrows the search to that provider; a
  // fragment on its own searches everything.
  const needle = normalizeModelQuery(parsed ? parsed.modelID : query)
  const scoped = parsed ? candidates.filter((c) => c.providerID === parsed.providerID) : candidates
  const match = (pool: ModelCandidate[]) =>
    pool.filter(
      (c) =>
        normalizeModelQuery(c.modelID) === needle ||
        normalizeModelQuery(`${c.providerID}/${c.modelID} ${c.name}`).includes(needle),
    )
  const matches = iife(() => {
    const inScope = match(scoped)
    return inScope.length > 0 || !parsed ? inScope : match(candidates)
  })
  if (matches.length === 0) throw unmatchedModelError(raw, candidates, needle)

  // The query naming a model outright settles it, even where a longer variant
  // also contains those words.
  const named = matches.filter(
    (c) => normalizeModelQuery(c.modelID) === needle || normalizeModelQuery(c.name) === needle,
  )
  return decide(named.length > 0 ? named : matches, raw, preferProviderID)
}

function ref(candidate: ModelCandidate) {
  return { providerID: candidate.providerID, modelID: candidate.modelID }
}

/**
 * One model, or the question of which. The session's own provider breaks a tie
 * across providers — staying where the session already is beats moving it —
 * but within one provider there is no honest tie-break, so the caller chooses.
 */
function decide(matches: ModelCandidate[], raw: string, preferProviderID: string) {
  if (matches.length === 1) return ref(matches[0])
  const preferred = matches.filter((c) => c.providerID === preferProviderID)
  if (preferred.length === 1) return ref(preferred[0])
  throw ambiguousModelError(raw, preferred.length > 1 ? preferred : matches)
}

/**
 * Newest first, then plainest first.
 *
 * The list is truncated, so what it shows has to be representative: within a
 * release date, the shortest ids are the base models and the long ones are
 * their tier and thinking variants, and sorting by length keeps a whole family
 * from eating the list and hiding another one entirely.
 */
function byRecency(a: ModelCandidate, b: ModelCandidate) {
  if (a.releaseDate !== b.releaseDate) return a.releaseDate < b.releaseDate ? 1 : -1
  if (a.modelID.length !== b.modelID.length) return a.modelID.length - b.modelID.length
  return a.modelID.localeCompare(b.modelID)
}

function ambiguousModelError(raw: string, matches: ModelCandidate[]) {
  const SHOWN = 25
  const shown = [...matches].sort(byRecency).slice(0, SHOWN)
  const rest = matches.length - shown.length
  return new Error(
    `"${raw}" matches ${matches.length} models: ${shown
      .map((c) => `${c.providerID}/${c.modelID}`)
      .join(", ")}${rest > 0 ? `, and ${rest} more` : ""}. Pass one of them as "providerID/modelID".`,
  )
}

/** `selectSubagentModel` over the models this instance can actually reach. */
async function resolveSubagentModel(raw: string, preferProviderID: string) {
  const providers = await providerList()
  // A subagent is an agent loop: a model that cannot call tools is never a
  // valid answer here, however well its name matches.
  const candidates = Object.values(providers).flatMap((provider) =>
    Object.values(provider.models)
      .filter((model) => model.capabilities.toolcall)
      .map((model) => ({
        providerID: provider.id,
        modelID: model.id,
        name: model.name,
        releaseDate: model.release_date,
      })),
  )
  return selectSubagentModel(candidates, raw, preferProviderID)
}

function extractQuestion(prompt: string) {
  const explicit = prompt.match(/^Question:\s*(.+)$/im)?.[1]?.trim()
  if (explicit) return explicit
  const firstLine = prompt
    .split("\n")
    .map((line) => line.trim())
    .find(Boolean)
  return firstLine?.slice(0, 160)
}

function extractConfidence(text: string) {
  return text.match(/^Confidence:\s*(.+)$/im)?.[1]?.trim()
}

function extractSourceCount(text: string) {
  const matches = text.match(/https?:\/\/[^\s)\]]+/g) ?? []
  return new Set(matches).size
}

function buildResearchMetadata(
  agentName: string,
  prompt: string,
  extra?: Omit<ResearchRunMetadata, "kind" | "question">,
) {
  if (agentName !== RESEARCH_AGENT) return undefined
  return {
    kind: "research",
    question: extractQuestion(prompt),
    ...extra,
  } satisfies ResearchRunMetadata
}

type DelegatorDecision =
  | {
      action: "finalize"
      reason?: string
      confidence?: string
      keyFindings?: string[]
    }
  | {
      action: "continue"
      reason?: string
      analysis?: string
      confidence?: string
      spawn?: {
        description: string
        prompt: string
        agent: string
      }
    }

interface StructuredResult {
  status: string
  summary: string
  confidence?: string
  findings?: string[]
  sources?: number
  nextSteps?: string[]
}

function buildStructuredResult(workerResults: Delegation.SynthesisItem[]): StructuredResult {
  const completedResults = workerResults.filter((r) => r.status === "complete")
  const failedResults = workerResults.filter((r) => r.status === "error" || r.status === "timeout")

  // Extract key information from results
  const allText = workerResults.map((r) => r.resultSummary ?? r.progressSummary ?? r.error ?? "").join("\n\n")

  // Count sources/links
  const sourceMatches = allText.match(/https?:\/\/[^\s)\]]+/g) ?? []
  const uniqueSources = new Set(sourceMatches).size

  return {
    status: failedResults.length > 0 ? "partial" : "complete",
    summary: allText.slice(0, 2000),
    sources: uniqueSources,
    findings: completedResults.length > 0 ? completedResults.map((r) => r.title).slice(0, 5) : undefined,
  }
}

function formatDelegatorPrompt(params: {
  agentName: string
  prompt: string
  resultsText: string
  accumulatedResults: Delegation.SynthesisItem[]
  sessionSummaries: string[]
  isLastRound: boolean
  iteration: number
}) {
  const structured = buildStructuredResult(params.accumulatedResults)

  return [
    params.iteration === 0 ? `## Worker Task Completed` : `## Follow-up Round ${params.iteration + 1}`,
    "",
    `**Agent:** @${params.agentName}`,
    `**Original Task:** ${params.prompt}`,
    "",
    "## Structured Results",
    `\`\`\`json
${JSON.stringify(structured, null, 2)}
\`\`\``,
    "",
    "## Raw Output",
    params.resultsText || "- none",
    "",
    ...(params.sessionSummaries.length > 0
      ? ["", "## Previous Synthesis", params.sessionSummaries[params.sessionSummaries.length - 1]]
      : []),
    "",
    params.isLastRound
      ? "**FINAL ROUND: You must synthesize all results and finalize.**"
      : "**Analyze results. If confident, finalize. If gaps remain, continue with follow-up.**",
    "",
    "## Required Response Format",
    "```",
    "Action: finalize | continue",
    "Reason: <one sentence explaining your decision>",
    "Confidence: high | medium | low",
    "Analysis: <optional - brief analysis if needed>",
    "```",
    params.isLastRound
      ? ""
      : [
          "",
          "## If Continue (provide spawn block)",
          "```",
          "Spawn:",
          "- description: <3-5 words>",
          "- prompt: <specific task to address gaps>",
          "- agent: <explore | researcher | refactor | general>",
          "```",
        ].join("\n"),
  ].join("\n")
}

type ReusableSessionValidation = {
  parentSessionID: string
  parentWorkspaceID?: string
  sessionID: string
  agentName: string
}

function extractErrorMessage(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined
  const value = error as {
    message?: string
    data?: {
      message?: string
    }
  }
  return value.data?.message ?? value.message
}

async function summarizeSubtaskSession(sessionID: string, result?: MessageV2.WithParts) {
  const messages = await runSession(
    Effect.gen(function* () {
      const session = yield* Session.Service
      return yield* session.messages({ sessionID })
    }),
  )
  const summary = messages
    .filter((x) => x.info.role === "assistant")
    .flatMap((msg) => msg.parts.filter((x): x is MessageV2.ToolPart => x.type === "tool"))
    .map((part) => ({
      id: part.id,
      tool: part.tool,
      state: {
        status: part.state.status,
        title: part.state.status === "completed" ? part.state.title : undefined,
      },
    }))

  const assistant =
    result?.info.role === "assistant" ? result : messages.findLast((item) => item.info.role === "assistant")
  const text = assistant?.parts.findLast((part): part is MessageV2.TextPart => part.type === "text")?.text ?? ""

  return {
    summary,
    text,
    assistant: assistant?.info.role === "assistant" ? assistant.info : undefined,
  }
}

function formatTaskOutput(text: string, sessionID: string, delegationID?: string) {
  const metadata = ["<task_metadata>", `session_id: ${sessionID}`]
  if (delegationID) metadata.push(`delegation_id: ${delegationID}`)
  metadata.push("</task_metadata>")
  const body = text.trim()
  return (body ? body + "\n\n" : "") + metadata.join("\n")
}

function summarizeLiveText(text: string) {
  const cleaned = text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !/^<[^>]+>$/.test(line))

  if (cleaned.length === 0) return undefined
  const summary = cleaned.slice(-2).join(" ")
  return summary.length > 180 ? summary.slice(0, 177).trimEnd() + "..." : summary
}

async function validateReusableSession({
  parentSessionID,
  parentWorkspaceID,
  sessionID,
  agentName,
}: ReusableSessionValidation) {
  const found = await runSession(
    Effect.gen(function* () {
      const session = yield* Session.Service
      return yield* session.get(sessionID)
    }),
  ).catch(() => undefined)
  if (!found) return undefined
  if (found.parentID !== parentSessionID) {
    throw new Error(`Task session "${sessionID}" does not belong to the current parent session.`)
  }
  if (parentWorkspaceID && found.workspaceID && found.workspaceID !== parentWorkspaceID) {
    throw new Error(`Task session "${sessionID}" belongs to a different workspace.`)
  }

  const messages = await runSession(
    Effect.gen(function* () {
      const session = yield* Session.Service
      return yield* session.messages({ sessionID: found.id })
    }),
  )
  const mismatchedAgent = messages.find(
    (item) => item.info.role === "assistant" && item.info.agent && item.info.agent !== agentName,
  )
  if (mismatchedAgent?.info.role === "assistant") {
    throw new Error(
      `Task session "${sessionID}" is already associated with @${mismatchedAgent.info.agent ?? "unknown"}.`,
    )
  }

  return found
}

function buildSubtaskPermission(hasTaskPermission: boolean, primaryTools: PrimaryToolsConfig | undefined) {
  return [
    {
      permission: "todowrite",
      pattern: "*",
      action: "deny" as const,
    },
    {
      permission: "todoread",
      pattern: "*",
      action: "deny" as const,
    },
    ...(hasTaskPermission
      ? []
      : [
          {
            permission: "task" as const,
            pattern: "*" as const,
            action: "deny" as const,
          },
        ]),
    ...(primaryTools?.map((t) => ({
      pattern: "*",
      action: "allow" as const,
      permission: t,
    })) ?? []),
  ]
}

// Strict permissions for follow-up agents - only read/search tools
function buildFollowupPermission() {
  return [
    { permission: "todowrite", pattern: "*", action: "deny" as const },
    { permission: "todoread", pattern: "*", action: "deny" as const },
    { permission: "task", pattern: "*", action: "deny" as const },
    { permission: "edit", pattern: "*", action: "deny" as const },
    { permission: "write", pattern: "*", action: "deny" as const },
    { permission: "bash", pattern: "*", action: "deny" as const },
    // Only allow read-only operations for follow-up
    { permission: "read", pattern: "*", action: "allow" as const },
    { permission: "glob", pattern: "*", action: "allow" as const },
    { permission: "grep", pattern: "*", action: "allow" as const },
  ]
}

async function createPromptInput(params: {
  sessionID: string
  prompt: string
  agentName: string
  hasTaskPermission: boolean
  model: {
    modelID: string
    providerID: string
  }
  primaryTools: PrimaryToolsConfig | undefined
}) {
  const promptParts = await runSessionPrompt(
    Effect.gen(function* () {
      const sessionPrompt = yield* SessionPrompt.Service
      return yield* sessionPrompt.resolvePromptParts(params.prompt)
    }),
  )
  return {
    messageID: Identifier.ascending("message"),
    sessionID: params.sessionID,
    model: params.model,
    agent: params.agentName,
    tools: {
      todowrite: false,
      todoread: false,
      ...(params.hasTaskPermission ? undefined : { task: false }),
      ...Object.fromEntries((params.primaryTools ?? []).map((t) => [t, false])),
    },
    parts: promptParts,
  } satisfies SessionPrompt.PromptInput
}

function parseDelegatorDecision(text: string): DelegatorDecision {
  const actionMatch = text.match(/(?:\*\*)?Action(?:\*\*)?[\s:]+(finalize|continue)/i)
  const action = (actionMatch?.[1]?.toLowerCase() ?? "finalize") as "finalize" | "continue"
  const reasonMatch = text.match(/(?:\*\*)?Reason(?:\*\*)?[\s:]+(.+)/i)
  const reason = reasonMatch?.[1]?.trim()

  // Extract confidence if present
  const confidenceMatch = text.match(/(?:\*\*)?Confidence(?:\*\*)?[\s:]+(high|medium|low)/i)
  const confidence = confidenceMatch?.[1]?.toLowerCase() as "high" | "medium" | "low" | undefined

  // Extract analysis if present
  const analysisMatch = text.match(/(?:\*\*)?Analysis(?:\*\*)?[\s:]+(.+?)(?=\n\n|\nSpawn|$)/is)
  const analysis = analysisMatch?.[1]?.trim()

  if (action === "finalize") {
    return { action, reason, confidence }
  }

  const description = text.match(/^-\s*description:\s*(.+)$/im)?.[1]?.trim()
  const prompt = text.match(/^-\s*prompt:\s*(.+)$/im)?.[1]?.trim()
  const agent = text.match(/^-\s*agent:\s*(.+)$/im)?.[1]?.trim()

  return {
    action,
    reason,
    confidence,
    analysis,
    spawn:
      description && prompt && agent
        ? {
            description,
            prompt,
            agent,
          }
        : undefined,
  }
}

async function runBackgroundDelegation(params: {
  session: Session.Info
  prompt: string
  agentName: string
  model: {
    modelID: string
    providerID: string
  }
  hasTaskPermission: boolean
  primaryTools: PrimaryToolsConfig | undefined
  delegationID: string
}) {
  const promptInput = await createPromptInput({
    sessionID: params.session.id,
    prompt: params.prompt,
    agentName: params.agentName,
    hasTaskPermission: params.hasTaskPermission,
    model: params.model,
    primaryTools: params.primaryTools,
  })
  const unsubProgress = subscribeDelegationProgress(params.session.id, params.delegationID)
  Instance.registerDisposer(unsubProgress)

  try {
    const result = await backgroundAgentLimit.run(() =>
      runSessionPrompt(
        Effect.gen(function* () {
          const sessionPrompt = yield* SessionPrompt.Service
          return yield* sessionPrompt.prompt(promptInput)
        }),
      ),
    )
    const summary = await summarizeSubtaskSession(params.session.id, result)
    const error = summary.assistant?.error
    const status = error ? (MessageV2.AbortedError.isInstance(error) ? "cancelled" : "error") : "complete"
    const errMsg = error ? extractErrorMessage(error) : undefined
    await Delegation.finalize(params.delegationID, status, summary.text, errMsg)
    return {
      result,
      summary,
      status,
      error: errMsg,
    }
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error)
    await Delegation.finalize(params.delegationID, "error", "", errMsg)
    throw error
  } finally {
    unsubProgress()
  }
}

/**
 * What a resumed subagent is told. It keeps its own session, so everything it
 * already did is still in context: the instruction it needs is "carry on", not
 * the original task restated.
 */
const RESUME_PROMPT =
  "Your previous run was interrupted before it finished. Review what you already did in this session, then continue from where you stopped — do not start the task over. When the work is done, report the result."

/** The model the run was actually using, which its own session already records. */
async function resolveResumeModel(sessionID: string, agent: Agent.Info) {
  const summary = await BackgroundRun.summarizeSession(sessionID).catch(() => undefined)
  const assistant = summary?.assistant
  if (assistant) return { modelID: assistant.modelID, providerID: assistant.providerID }
  if (agent.model) return { modelID: agent.model.modelID, providerID: agent.model.providerID }
  return undefined
}

/**
 * Restarts a delegation that stopped without an answer, reusing its session so
 * the agent resumes instead of repeating itself. False means the run cannot be
 * resumed: wrong status, attempts exhausted, or the session is gone.
 */
export async function resumeBackgroundDelegation(delegationID: string): Promise<boolean> {
  const record = await Delegation.getDurable(delegationID).catch(() => undefined)
  const sessionID = record?.sessionID
  if (!record || !sessionID) return false
  if (!BackgroundRun.isResumable(record.status)) return false

  const agent = await agentGet(record.agent).catch(() => undefined)
  if (!agent) return false

  const session = await runSession(
    Effect.gen(function* () {
      const service = yield* Session.Service
      return yield* service.get(sessionID)
    }),
  ).catch(() => undefined)
  if (!session) return false

  const model = await resolveResumeModel(sessionID, agent)
  if (!model) return false

  // Reopened last: every step above can fail, and a run left `running` with
  // nobody driving it is worse than one still marked with how it died.
  const reopened = await BackgroundRun.reopen(delegationID).catch(() => undefined)
  if (!reopened) return false
  Delegation.reattach(reopened)

  const config = await configGet()
  log.info("resuming delegation", {
    delegationID,
    agent: agent.name,
    attempt: reopened.resumeCount,
  })
  await runBackgroundDelegation({
    session,
    prompt: RESUME_PROMPT,
    agentName: agent.name,
    model,
    hasTaskPermission: agent.permission.some((rule) => rule.permission === "task"),
    primaryTools: config.experimental?.primary_tools,
    delegationID,
  })
  return true
}

/**
 * Restarts at startup what a crash left behind. The runs are launched, not
 * awaited, and take the same semaphore as any other background agent, so a
 * machine that just came back up is not asked to run all of them at once.
 */
export async function resumeInterruptedDelegations(): Promise<number> {
  const candidates = await BackgroundRun.listAutoResumable().catch(() => [])
  for (const record of candidates) {
    void resumeBackgroundDelegation(record.id).catch((error) => {
      log.warn("failed to resume interrupted delegation", {
        delegationID: record.id,
        error: String(error),
      })
    })
  }
  return candidates.length
}

function subscribeDelegationProgress(sessionID: string, delegationID: string) {
  let lastSummary: string | undefined = "Starting background task"
  void Delegation.updateProgress(delegationID, lastSummary)
  // The progress summary is persisted with the background-run record on every call.
  // PartUpdated fires per streaming token, so writing on each event hammers the
  // filesystem — coalesce to at most one write per PROGRESS_WRITE_THROTTLE_MS.
  const throttled = throttleTrailing((summary: string) => {
    void Delegation.updateProgress(delegationID, summary).catch(() => undefined)
  }, PROGRESS_WRITE_THROTTLE_MS)
  const unsubscribe = Bus.subscribe(MessageV2.Event.PartUpdated, async (evt) => {
    if (evt.properties.part.sessionID !== sessionID) return
    // Any part at all means the subagent is alive, even when the summary below
    // is unchanged and the throttled durable write is skipped. The delegation
    // watchdog reads this to tell a slow task from a hung one.
    Delegation.touch(delegationID)
    const part = evt.properties.part
    let nextSummary: string | undefined
    if (part.type === "tool") {
      nextSummary = `Tool ${part.tool}: ${part.state.status}${
        part.state.status === "completed" && part.state.title ? ` (${part.state.title})` : ""
      }`
    } else if (part.type === "text" && !part.synthetic && !part.ignored) {
      nextSummary = summarizeLiveText(part.text)
    }
    if (!nextSummary || nextSummary === lastSummary) return
    lastSummary = nextSummary
    throttled.call(nextSummary)
  })
  return () => {
    throttled.flush()
    unsubscribe()
  }
}

async function wakeParentSession(
  parentSessionID: string,
  result: {
    jobId: string
    delegationId: string
    delegatorDelegationId: string
    description: string
    status: string
    summary: string
    parentAgent?: string
  },
) {
  try {
    const summaryLines = result.summary.split("\n").slice(0, 100).join("\n")
    const truncated = result.summary.split("\n").length > 100
    const lines = [
      `Background task "${result.description}" finished.`,
      `Status: ${result.status}`,
      `Job ID: ${result.jobId}`,
      "",
      "Result:",
      summaryLines,
      truncated ? "\n...(truncated)" : "",
      "",
      `Use delegation(action="read", delegationId="${result.delegatorDelegationId}") for the full result.`,
    ]

    await runPromiseWithLayer(
      SessionPrompt.defaultLayer,
      withCurrentInstance(
        Effect.gen(function* () {
          const sessionPrompt = yield* SessionPrompt.Service
          return yield* sessionPrompt.prompt({
            sessionID: parentSessionID,
            delivery: "queue",
            agent: result.parentAgent,
            parts: [
              {
                type: "text",
                text: lines.join("\n"),
              },
            ],
          })
        }),
      ),
    )
  } catch (error) {
    log.error("failed to wake parent session for background task", {
      error: String(error),
      jobId: result.jobId,
    })
  }
}

async function launchBackgroundSubtask(params: {
  description: string
  prompt: string
  source: "task" | "model-subtask"
  parentSessionID: string
  parentAgent?: string
  agent: Agent.Info
  session: Session.Info
  model: {
    modelID: string
    providerID: string
  }
  /**
   * Model for the delegator's synthesis rounds. Kept separate from `model` so
   * that pointing a worker at an expensive model doesn't also move nikcli's
   * own bookkeeping loop onto it.
   */
  delegatorModel: {
    modelID: string
    providerID: string
  }
  hasTaskPermission: boolean
  primaryTools: PrimaryToolsConfig | undefined
  metadata?: Record<string, unknown>
}): Promise<BackgroundTaskResult> {
  const delegatorSession = await runSession(
    Effect.gen(function* () {
      const session = yield* Session.Service
      return yield* session.create({
        parentID: params.parentSessionID,
        title: `delegator: ${params.description} (@delegator)`,
        permission: buildSubtaskPermission(false, params.primaryTools),
      })
    }),
  )

  const delegation = await Delegation.create({
    parentSessionID: params.parentSessionID,
    agent: params.agent.name,
    prompt: params.prompt,
    session: {
      id: params.session.id,
      directory: params.session.directory,
      workspaceID: params.session.workspaceID ?? "",
    },
    source: params.agent.name === RESEARCH_AGENT ? "research" : params.source,
    metadata: params.metadata,
    delegatorSessionID: delegatorSession.id,
    delegatorEnabled: true,
    role: "worker",
  })
  Delegation.setSessionID(delegation.id, params.session.id)

  const delegatorDelegation = await Delegation.create({
    parentSessionID: params.parentSessionID,
    agent: "delegator",
    prompt: `Synthesize @${params.agent.name}: ${params.prompt}`,
    session: {
      id: delegatorSession.id,
      directory: delegatorSession.directory,
      workspaceID: delegatorSession.workspaceID ?? "",
    },
    source: "delegator",
    metadata: params.metadata,
    jobID: delegation.jobID,
    rootDelegationID: delegation.rootDelegationID,
    parentDelegationID: delegation.id,
    role: "delegator",
  })
  Delegation.setSessionID(delegatorDelegation.id, delegatorSession.id)
  // Close the forward link advertised by the BackgroundRun schema so callers
  // can resolve a subagent delegation's supervisor in O(1) via its record.
  await Delegation.linkDelegator(delegation.id, delegatorDelegation.id)

  void Promise.resolve()
    .then(async () => {
      const workerRun = await runBackgroundDelegation({
        session: params.session,
        prompt: params.prompt,
        agentName: params.agent.name,
        model: params.model,
        hasTaskPermission: params.hasTaskPermission,
        primaryTools: params.primaryTools,
        delegationID: delegation.id,
      })

      await Delegation.waitForSettledJob(delegation.jobID!).catch(() => undefined)
      const synthesisItems = await Delegation.collectResultsForJob(delegation.jobID!).catch(() => [])
      const MAX_ITERATIONS = 3
      let accumulatedResults: Delegation.SynthesisItem[] = synthesisItems
      const sessionSummaries: string[] = []
      let lastDelegatorSummary: Awaited<ReturnType<typeof summarizeSubtaskSession>> | null = null
      let _lastWorkerStatus = workerRun.status

      for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
        const resultsText = accumulatedResults
          .map((item) => {
            const details = item.resultSummary ?? item.progressSummary ?? item.error ?? "(no output)"
            return `- ${item.id} [${item.status}] @${item.agent}\n${details}`
          })
          .join("\n\n")

        const isLastRound = iteration === MAX_ITERATIONS - 1

        const wakeText = formatDelegatorPrompt({
          agentName: params.agent.name,
          prompt: params.prompt,
          resultsText,
          accumulatedResults,
          sessionSummaries,
          isLastRound,
          iteration,
        })

        const delegatorResult = await backgroundAgentLimit.run(() =>
          runSessionPrompt(
            Effect.gen(function* () {
              const sessionPrompt = yield* SessionPrompt.Service
              return yield* sessionPrompt.prompt({
                messageID: Identifier.ascending("message"),
                sessionID: delegatorSession.id,
                model: params.delegatorModel,
                agent: "delegator",
                tools: {
                  todowrite: false,
                  todoread: false,
                  task: false,
                },
                parts: [{ type: "text" as const, text: wakeText }],
              })
            }),
          ),
        )

        const delegatorSummary = await summarizeSubtaskSession(delegatorSession.id, delegatorResult)
        lastDelegatorSummary = delegatorSummary
        sessionSummaries.push(delegatorSummary.text)

        const decision = parseDelegatorDecision(delegatorSummary.text ?? "")

        if (decision.action === "finalize" || isLastRound || !decision.spawn) break

        const spawn = decision.spawn
        const followupAgent = await agentGet(spawn.agent)
        if (!followupAgent) break

        // Use strict read-only permissions for follow-up agents
        const followupPermission =
          spawn.agent === "explore" || spawn.agent === "researcher"
            ? buildFollowupPermission()
            : buildSubtaskPermission(false, params.primaryTools)

        const followupSession = await runSession(
          Effect.gen(function* () {
            const session = yield* Session.Service
            return yield* session.create({
              parentID: params.parentSessionID,
              title: `${spawn.description} (@${followupAgent.name} follow-up)`,
              permission: followupPermission,
            })
          }),
        )
        const followupDelegation = await Delegation.create({
          parentSessionID: params.parentSessionID,
          agent: followupAgent.name,
          prompt: spawn.prompt,
          session: {
            id: followupSession.id,
            directory: followupSession.directory,
            workspaceID: followupSession.workspaceID ?? "",
          },
          source: "delegator-followup",
          jobID: delegation.jobID,
          rootDelegationID: delegation.rootDelegationID,
          parentDelegationID: delegatorDelegation.id,
          delegatorSessionID: delegatorSession.id,
          role: "followup",
        })
        Delegation.setSessionID(followupDelegation.id, followupSession.id)
        const followupRun = await runBackgroundDelegation({
          session: followupSession,
          prompt: spawn.prompt,
          agentName: followupAgent.name,
          model: params.model,
          hasTaskPermission: followupPermission.some((rule) => rule.permission === "task"),
          primaryTools: params.primaryTools,
          delegationID: followupDelegation.id,
        })
        _lastWorkerStatus = followupRun.status

        await Delegation.waitForSettledJob(delegation.jobID!).catch(() => undefined)
        const newResults = await Delegation.collectResultsForJob(delegation.jobID!).catch(() => [])
        const seen = new Set(accumulatedResults.map((r) => r.id))
        for (const r of newResults) {
          if (!seen.has(r.id)) accumulatedResults.push(r)
        }
      }

      const finalSummary = sessionSummaries[sessionSummaries.length - 1] ?? ""
      const finalErr = lastDelegatorSummary?.assistant?.error
      const finalStatus = finalErr ? (MessageV2.AbortedError.isInstance(finalErr) ? "cancelled" : "error") : "complete"
      const delegatorMetadata =
        params.agent.name === RESEARCH_AGENT
          ? buildResearchMetadata(params.agent.name, params.prompt, {
              followUpRounds: Math.max(0, sessionSummaries.length - 1),
              sourceCount: extractSourceCount(finalSummary),
              confidence: extractConfidence(finalSummary),
            })
          : params.metadata
      await Delegation.finalize(
        delegatorDelegation.id,
        finalStatus,
        finalSummary,
        finalErr ? extractErrorMessage(finalErr) : undefined,
        delegatorMetadata,
      )
      await wakeParentSession(params.parentSessionID, {
        jobId: delegation.jobID!,
        delegationId: delegation.id,
        delegatorDelegationId: delegatorDelegation.id,
        description: params.description,
        status: finalStatus,
        summary: finalSummary,
        parentAgent: params.parentAgent,
      })
    })
    .catch(async (error) => {
      const errMsg = error instanceof Error ? error.message : String(error)
      await Delegation.finalize(delegatorDelegation.id, "error", "", `Subagent threw: ${errMsg}`)
      await wakeParentSession(params.parentSessionID, {
        jobId: delegation.jobID!,
        delegationId: delegation.id,
        delegatorDelegationId: delegatorDelegation.id,
        description: params.description,
        status: "error",
        summary: `Subagent threw: ${errMsg}`,
        parentAgent: params.parentAgent,
      })
    })
    .catch((error) => {
      // Terminal guard: the error path above can itself reject (finalize/wake),
      // which would otherwise surface as an unhandled rejection.
      log.error("background delegation error handling failed", {
        delegationID: delegation.id,
        error: error instanceof Error ? error.message : String(error),
      })
    })

  return {
    jobId: delegation.jobID!,
    rootDelegationId: delegation.rootDelegationID!,
    delegationId: delegation.id,
    delegatorDelegationId: delegatorDelegation.id,
    delegatorSessionId: delegatorSession.id,
    sessionId: params.session.id,
    kind: typeof params.metadata?.kind === "string" ? params.metadata.kind : undefined,
    question: typeof params.metadata?.question === "string" ? params.metadata.question : undefined,
  }
}

export async function runSubtask(params: TaskParams, ctx: Tool.Context<TaskMetadata>) {
  const config = await configGet()
  // SECURITY: bypassAgentCheck should only be true when set by internal system code
  // (e.g., when processing SubtaskPart from model). It should NEVER be derived from
  // user-controllable data like message parts. See session/prompt.ts for proper usage.
  const bypass = Boolean(ctx.extra?.bypassAgentCheck)

  if (!bypass) {
    await ctx.ask({
      permission: "task",
      patterns: [params.subagent_type],
      always: ["*"],
      metadata: {
        description: params.description,
        subagent_type: params.subagent_type,
      },
    })
  }

  const agent = await agentGet(params.subagent_type)
  if (!agent) throw new Error(`Unknown agent type: ${params.subagent_type} is not a valid agent type`)

  const hasTaskPermission = agent.permission.some((rule) => rule.permission === "task")
  const parentSession = await runSession(
    Effect.gen(function* () {
      const session = yield* Session.Service
      return yield* session.get(ctx.sessionID)
    }),
  )
  const researchMetadata = buildResearchMetadata(agent.name, params.prompt)

  // A running research job is reused rather than duplicated — unless this call
  // names a model, which makes it a request for a different run, not the one
  // already in flight on the old model.
  if (params.background && agent.name === RESEARCH_AGENT && !params.model) {
    const existing = await Delegation.findRunningForParent(ctx.sessionID, agent.name)
    if (existing) {
      const metadata: TaskMetadata = {
        background: true,
        delegationId: existing.id,
        delegatorDelegationId: existing.delegatorID,
        delegatorSessionId: existing.delegatorSessionID,
        sessionId: existing.sessionID ?? "unknown",
        kind: "research",
        question:
          (typeof existing.metadata?.question === "string" ? existing.metadata.question : undefined) ??
          researchMetadata?.question,
        reused: true,
      }
      if (existing.sessionID) {
        await ctx.progress({
          structured: {
            sessionID: existing.sessionID,
            status: "running",
          },
        })
      }
      ctx.metadata({ title: params.description, metadata })
      return {
        title: params.description,
        metadata,
        output: formatTaskOutput(
          `Reusing running @${agent.name} background task.\nDelegator: ${existing.delegatorID ?? "N/A"}`,
          existing.sessionID ?? "unknown",
          existing.id,
        ),
      }
    }
  }

  const msg = await MessageV2.get({
    sessionID: ctx.sessionID,
    messageID: ctx.messageID,
  })
  if (msg.info.role !== "assistant") throw new Error("Not an assistant message")

  const inheritedModel = {
    modelID: msg.info.modelID,
    providerID: msg.info.providerID,
  }
  // An explicit `model` outranks the agent's own pin: the user naming a model
  // for this particular piece of work is the more specific instruction.
  const overrideModel = params.model ? await resolveSubagentModel(params.model, inheritedModel.providerID) : undefined
  const defaultModel = agent.model ?? inheritedModel
  const model = overrideModel ?? defaultModel
  const overrideRef = overrideModel ? `${overrideModel.providerID}/${overrideModel.modelID}` : undefined

  const session = await iife(async () => {
    if (params.session_id) {
      const found = await validateReusableSession({
        parentSessionID: ctx.sessionID,
        parentWorkspaceID: parentSession.workspaceID,
        sessionID: params.session_id,
        agentName: agent.name,
      })
      if (found) return found
    }

    return await runSession(
      Effect.gen(function* () {
        const session = yield* Session.Service
        return yield* session.create({
          parentID: ctx.sessionID,
          title: params.description + ` (@${agent.name} subagent)`,
          permission: buildSubtaskPermission(hasTaskPermission, config.experimental?.primary_tools),
        })
      }),
    )
  })

  await ctx.progress({
    structured: {
      sessionID: session.id,
      status: "running",
    },
  })

  ctx.metadata({
    title: params.description,
    metadata: {
      sessionId: session.id,
      model: overrideRef,
      kind: researchMetadata?.kind,
      question: researchMetadata?.question,
    },
  })

  if (params.background) {
    const backgroundTask = await launchBackgroundSubtask({
      description: params.description,
      prompt: params.prompt,
      source: ctx.extra?.backgroundSource === "model-subtask" ? "model-subtask" : "task",
      parentSessionID: ctx.sessionID,
      parentAgent: ctx.agent,
      agent,
      session,
      model: {
        modelID: model.modelID,
        providerID: model.providerID,
      },
      delegatorModel: {
        modelID: defaultModel.modelID,
        providerID: defaultModel.providerID,
      },
      hasTaskPermission,
      primaryTools: config.experimental?.primary_tools,
      metadata: researchMetadata,
    })

    ctx.metadata({
      title: params.description,
      metadata: {
        background: true,
        model: overrideRef,
        jobId: backgroundTask.jobId,
        rootDelegationId: backgroundTask.rootDelegationId,
        delegationId: backgroundTask.delegationId,
        delegatorDelegationId: backgroundTask.delegatorDelegationId,
        delegatorSessionId: backgroundTask.delegatorSessionId,
        sessionId: backgroundTask.sessionId,
        kind: backgroundTask.kind,
        question: backgroundTask.question,
        sourceCount: backgroundTask.sourceCount,
        confidence: backgroundTask.confidence,
        followUpRounds: backgroundTask.followUpRounds,
        reused: backgroundTask.reused,
      },
    })

    return {
      title: params.description,
      metadata: {
        background: true,
        model: overrideRef,
        jobId: backgroundTask.jobId,
        rootDelegationId: backgroundTask.rootDelegationId,
        delegationId: backgroundTask.delegationId,
        delegatorDelegationId: backgroundTask.delegatorDelegationId,
        delegatorSessionId: backgroundTask.delegatorSessionId,
        sessionId: backgroundTask.sessionId,
        kind: backgroundTask.kind,
        question: backgroundTask.question,
        sourceCount: backgroundTask.sourceCount,
        confidence: backgroundTask.confidence,
        followUpRounds: backgroundTask.followUpRounds,
        reused: backgroundTask.reused,
      },
      output: formatTaskOutput(
        `Background task started for @${agent.name}${overrideRef ? ` on ${overrideRef}` : ""}. Delegator will synthesize results.\nDelegator: ${backgroundTask.delegatorDelegationId}`,
        backgroundTask.sessionId,
        backgroundTask.delegationId,
      ),
    }
  }

  function cancel() {
    void runSessionPrompt(
      Effect.gen(function* () {
        const sessionPrompt = yield* SessionPrompt.Service
        yield* sessionPrompt.cancel(session.id)
      }),
    )
  }
  ctx.abort.addEventListener("abort", cancel)
  using _ = defer(() => ctx.abort.removeEventListener("abort", cancel))
  const parts: Record<string, ToolSummaryItem> = {}
  let liveSummary: string | undefined
  // Sorting + publishing metadata on every token is wasteful; coalesce so the
  // foreground UI still feels live but the work runs on a budget.
  const foregroundMetadata = throttleTrailing(() => {
    ctx.metadata({
      title: params.description,
      metadata: {
        summary: Object.values(parts).sort((a, b) => a.id.localeCompare(b.id)),
        sessionId: session.id,
        model: overrideRef,
        liveSummary,
        kind: researchMetadata?.kind,
        question: researchMetadata?.question,
      },
    })
  }, FOREGROUND_METADATA_THROTTLE_MS)
  const updateForegroundMetadata = () => foregroundMetadata.call()
  const unsub = Bus.subscribe(MessageV2.Event.PartUpdated, async (evt) => {
    if (evt.properties.part.sessionID !== session.id) return
    const part = evt.properties.part
    if (part.type === "tool") {
      parts[part.id] = {
        id: part.id,
        tool: part.tool,
        state: {
          status: part.state.status,
          title: part.state.status === "completed" ? part.state.title : undefined,
        },
      }
      updateForegroundMetadata()
      return
    }
    if (part.type !== "text" || part.synthetic || part.ignored) return
    const nextLiveSummary = summarizeLiveText(part.text)
    if (!nextLiveSummary || nextLiveSummary === liveSummary) return
    liveSummary = nextLiveSummary
    updateForegroundMetadata()
  })
  try {
    const promptInput = await createPromptInput({
      sessionID: session.id,
      prompt: params.prompt,
      agentName: agent.name,
      hasTaskPermission,
      model: {
        modelID: model.modelID,
        providerID: model.providerID,
      },
      primaryTools: config.experimental?.primary_tools,
    })
    const result = await runSessionPrompt(
      Effect.gen(function* () {
        const sessionPrompt = yield* SessionPrompt.Service
        return yield* sessionPrompt.prompt(promptInput)
      }),
    )
    const summary = await summarizeSubtaskSession(session.id, result)

    return {
      title: params.description,
      metadata: {
        summary: summary.summary,
        sessionId: session.id,
        model: overrideRef,
        liveSummary: summarizeLiveText(summary.text),
        kind: researchMetadata?.kind,
        question: researchMetadata?.question,
        sourceCount: agent.name === RESEARCH_AGENT ? extractSourceCount(summary.text) : undefined,
        confidence: agent.name === RESEARCH_AGENT ? extractConfidence(summary.text) : undefined,
      },
      output: formatTaskOutput(summary.text, session.id),
    }
  } finally {
    foregroundMetadata.flush()
    unsub()
  }
}

export const TaskTool = Tool.define<typeof parameters, TaskMetadata>("task", async (ctx) => {
  const agents = await agentList().then((x) => x.filter((a) => a.mode !== "primary"))

  const caller = ctx?.agent
  const accessibleAgents = caller
    ? agents.filter((a) => PermissionNext.evaluate("task", a.name, caller.permission).action !== "deny")
    : agents

  const description = DESCRIPTION.replace(
    "{agents}",
    accessibleAgents
      .map((a) => `- ${a.name}: ${a.description ?? "This subagent should only be called manually by the user."}`)
      .join("\n"),
  )
  return {
    description,
    parameters,
    async execute(params: z.infer<typeof parameters>, ctx) {
      return runSubtask(params, ctx)
    },
  }
})
