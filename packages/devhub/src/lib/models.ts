import { Effect } from "effect"
import { createResource } from "solid-js"
import { Gateway, type ModelRef } from "./agent"
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

type ProviderList = {
  readonly all: readonly {
    readonly id: string
    readonly name: string
    readonly models: Record<
      string,
      {
        id: string
        name?: string
        status?: string
        cost?: { input?: number; output?: number }
        limit?: { context?: number }
        capabilities?: { reasoning?: boolean }
      }
    >
  }[]
  readonly connected: readonly string[]
  readonly default: Record<string, string>
}

/** Models of every connected provider — the ones a prompt can actually be sent to right now. */
export const loadModels = Gateway.use((g) => g.json<ProviderList>({ method: "GET", path: "/provider" })).pipe(
  Effect.map((list) => {
    const connected = new Set(list.connected)
    return list.all
      .filter((p) => connected.has(p.id))
      .flatMap((p) =>
        Object.values(p.models)
          .filter((m) => m.status !== "deprecated")
          .map(
            (m): ModelOption => ({
              providerID: p.id,
              providerName: p.name,
              modelID: m.id,
              name: m.name ?? m.id,
              inputCost: m.cost?.input,
              outputCost: m.cost?.output,
              context: m.limit?.context,
              reasoning: m.capabilities?.reasoning,
            }),
          ),
      )
      .sort((a, b) => a.providerName.localeCompare(b.providerName) || a.name.localeCompare(b.name))
  }),
)

/** Reactive model catalogue; reloads when the selected service changes. */
export function createModels() {
  const [models, { refetch }] = createResource(
    () => app.service()?.url,
    (url) => (url ? runApp(loadModels) : Promise.resolve([] as ModelOption[])),
  )
  return {
    models: () => models() ?? [],
    loading: () => models.loading,
    error: () => (models.error ? String(models.error) : undefined),
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

export function createAgents() {
  const [agents] = createResource(
    () => app.service()?.url,
    (url) => (url ? runApp(loadAgents) : Promise.resolve([] as AgentOption[])),
  )
  return () => agents() ?? []
}
