import { Effect, Layer } from "effect"
import { Agent, Gateway, agentLayer, gatewayLayer } from "./agent"
import { app } from "./store"

/** The app's service graph: Gateway (Rust proxy) ← Agent (sessions). Exposes both. */
export const appLayer = agentLayer(() => app.repo()).pipe(Layer.provideMerge(gatewayLayer(() => app.service()?.url)))

export type AppServices = Agent | Gateway

/** Runs an Effect against the live service graph; rejects with the failure/defect. */
export const runApp = <A, E>(effect: Effect.Effect<A, E, AppServices>, signal?: AbortSignal): Promise<A> =>
  Effect.runPromise(effect.pipe(Effect.provide(appLayer)), { signal })
