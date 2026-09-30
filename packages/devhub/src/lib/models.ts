import { Effect } from "effect"
import { createResource, createRoot } from "solid-js"
import { Gateway, type ModelRef } from "./agent"
import { errorText, native, type ModelRow } from "./native"
import { runApp } from "./runtime"
import { app } from "./store"

export type ModelOption = ModelRef & {
  readonly providerName: string
  readonly name: string
  /** USD per million tokens, when the catalogue knows it. */
  readonly inputCost?: number
  readonly outputCost?: number
  readonly context?: number
  readonly reasoning?: boolean
}

/** Adapts the natively reduced rows to the shape the UI uses. */
const toOption = (m: ModelRow): ModelOption => ({
  providerID: m.providerId,
  providerName: m.providerName,
  modelID: m.modelId,
  name: m.name,
  inputCost: m.inputCost ?? undefined,
  outputCost: m.outputCost ?? undefined,
  context: m.context ?? undefined,
  reasoning: m.reasoning,
})

/**
 * One catalogue for the whole app, loaded once per service. Every consumer (assistant, playground)
 * shares it instead of each downloading and parsing the provider list on its own.
 */
const catalogue = createRoot(() => {
  const [models, { refetch }] = createResource(
    () => (app.service()?.alive ? app.service()!.url : undefined),
    async (url) => (await native.providerModels(url)).map(toOption),
  )
  return { models, refetch }
})

/** Reactive model catalogue; reloads when the selected service changes. */
export function createModels() {
  const { models, refetch } = catalogue
  return {
    models: () => models() ?? [],
    loading: () => models.loading,
    error: () => (models.error ? errorText(models.error) : undefined),
    refetch,
  }
}

export const modelKey = (m: ModelRef) => `${m.providerID}/${m.modelID}`
export const modelLabel = (m: ModelOption) => `${m.name}`

export type AgentOption = { readonly name: string; readonly description?: string }

/** nikcli's own agents that can lead a session (hidden and subagent-only ones are not offered). */
export const loadAgents = Gateway.use((g) =>
  g.json<{ name: string; description?: string; mode?: string; hidden?: boolean }[]>({ method: "GET", path: "/agent" }),
).pipe(
  Effect.map((list) =>
    list
      .filter((a) => !a.hidden && a.mode !== "subagent")
      .map((a): AgentOption => ({ name: a.name, description: a.description }))
      .sort((a, b) => (a.name === "build" ? -1 : b.name === "build" ? 1 : a.name.localeCompare(b.name))),
  ),
)

const agentList = createRoot(() => {
  const [agents] = createResource(
    () => (app.service()?.alive ? app.service()!.url : undefined),
    (url) => (url ? runApp(loadAgents) : Promise.resolve([] as AgentOption[])),
  )
  return agents
})

export function createAgents() {
  return () => agentList() ?? []
}
