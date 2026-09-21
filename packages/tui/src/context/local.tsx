import { createStore } from "solid-js/store"
import { batch, createEffect, createMemo, on } from "solid-js"
import { useSync } from "@tui/context/sync"
import { useTheme } from "@tui/context/theme"
import { useRoute } from "@tui/context/route"
import { useSDK } from "@tui/context/sdk"
import { useKV } from "@tui/context/kv"
import { uniqueBy } from "remeda"
import path from "path"
import { Global } from "@nikcli-ai/util/global"
import { iife } from "@nikcli-ai/util/iife"
import { createSimpleContext } from "./helper"
import { useToast } from "../ui/toast"
import { parseModel } from "@nikcli-ai/util/model"
import { useArgs } from "./args"
import { RGBA } from "@opentui/core"
import { moveSelection } from "@tui/ui/select-controller"

export const {
  use: useLocal,
  provider: LocalProvider,
  context: LocalContext,
} = createSimpleContext({
  name: "Local",
  init: () => {
    const sync = useSync()
    const sdk = useSDK()
    const toast = useToast()
    const kv = useKV()

    function isModelValid(model: { providerID: string; modelID: string }) {
      const provider = sync.data.provider.find((x) => x.id === model.providerID)
      return !!provider?.models[model.modelID]
    }

    function getFirstValidModel(...modelFns: (() => { providerID: string; modelID: string } | undefined)[]) {
      for (const modelFn of modelFns) {
        const model = modelFn()
        if (!model) continue
        if (isModelValid(model)) return model
      }
    }

    const agent = iife(() => {
      const PRIMARY_AGENT_NAMES = ["build", "plan", "general"]
      const agents = createMemo(() => sync.data.agent.filter((x) => PRIMARY_AGENT_NAMES.includes(x.name)))
      const subagents = createMemo(() =>
        sync.data.agent.filter((x) => !x.hidden && !PRIMARY_AGENT_NAMES.includes(x.name)),
      )
      const [agentStore, setAgentStore] = createStore<{
        current: string | undefined
      }>({
        current: undefined,
      })

      // Sync initial value when agents list is available
      createEffect(() => {
        const list = agents()
        if (agentStore.current === undefined && list.length > 0) {
          setAgentStore("current", list[0].name)
        }
      })

      const { theme } = useTheme()
      const colors = createMemo(() => [
        theme.accent.secondary,
        theme.accent.alt,
        theme.status.success.fg,
        theme.status.warning.fg,
        theme.accent.fg,
        theme.status.error.fg,
      ])
      return {
        list() {
          return agents()
        },
        current() {
          const list = agents()
          const current = list.find((x) => x.name === agentStore.current)
          // Fallback to first agent if current is not found
          return current ?? list[0]
        },
        /** True when the user has not yet explicitly picked an agent via pickStarter. */
        needsStarter() {
          return !kv.get("agent.starter_picked", false)
        },
        /** Pick a starter agent and mark the choice as explicit. */
        pickStarter(name: string) {
          if (!agents().some((x) => x.name === name))
            return toast.show({
              variant: "warning",
              message: `Agent not found: ${name}`,
              duration: 3000,
            })
          setAgentStore("current", name)
          kv.set("agent.starter_picked", true)
        },
        set(name: string) {
          if (!agents().some((x) => x.name === name))
            return toast.show({
              variant: "warning",
              message: `Agent not found: ${name}`,
              duration: 3000,
            })
          setAgentStore("current", name)
        },
        move(direction: 1 | -1) {
          batch(() => {
            const next = moveSelection(
              agents().findIndex((x) => x.name === agentStore.current),
              {
                count: agents().length,
                delta: direction,
                policy: "wrap",
              },
            )
            const value = agents()[next]
            if (value) setAgentStore("current", value.name)
          })
        },
        moveSub(direction: 1 | -1) {
          const subs = subagents()
          if (subs.length === 0) return
          batch(() => {
            const next = moveSelection(
              subs.findIndex((x) => x.name === agentStore.current),
              {
                count: subs.length,
                delta: direction,
                policy: "wrap",
              },
            )
            const value = subs[next]
            if (value) setAgentStore("current", value.name)
          })
        },
        color(name: string) {
          const all = sync.data.agent
          const agent = all.find((x) => x.name === name)
          if (agent?.color) return RGBA.fromHex(agent.color)
          const c = colors()
          const KNOWN_INDEX: Record<string, number> = {
            ralph: 0,
            build: 1,
            plan: 2,
            general: 3,
            "ultrareview-reviewer": 4,
            explore: 5,
            "fast-explore": 1,
            planner: 2,
            "code-reviewer": 3,
            debugger: 4,
            "test-runner": 5,
            refactor: 0,
          }
          if (name in KNOWN_INDEX) return c[KNOWN_INDEX[name]!]!
          const hash = [...name].reduce((acc, ch) => acc + ch.charCodeAt(0), 0)
          return c[hash % c.length]
        },
      }
    })

    const model = iife(() => {
      const [modelStore, setModelStore] = createStore<{
        ready: boolean
        model: Record<
          string,
          {
            providerID: string
            modelID: string
          }
        >
        recent: {
          providerID: string
          modelID: string
        }[]
        favorite: {
          providerID: string
          modelID: string
        }[]
        variant: Record<string, string | undefined>
      }>({
        ready: false,
        model: {},
        recent: [],
        favorite: [],
        variant: {},
      })

      const file = Bun.file(path.join(Global.Path.state, "model.json"))
      const state = {
        pending: false,
      }

      function save() {
        if (!modelStore.ready) {
          state.pending = true
          return
        }
        state.pending = false
        Bun.write(
          file,
          JSON.stringify({
            recent: modelStore.recent,
            favorite: modelStore.favorite,
            variant: modelStore.variant,
          }),
        )
      }

      file
        .json()
        .then((x) => {
          if (Array.isArray(x.recent)) setModelStore("recent", x.recent)
          if (Array.isArray(x.favorite)) setModelStore("favorite", x.favorite)
          if (typeof x.variant === "object" && x.variant !== null) setModelStore("variant", x.variant)
        })
        .catch(() => {})
        .finally(() => {
          setModelStore("ready", true)
          if (state.pending) save()
        })

      const args = useArgs()
      const fallbackModel = createMemo(() => {
        if (args.model) {
          const { providerID, modelID } = parseModel(args.model)
          if (isModelValid({ providerID, modelID })) {
            return {
              providerID,
              modelID,
            }
          }
        }

        if (sync.data.config.model) {
          const { providerID, modelID } = parseModel(sync.data.config.model)
          if (isModelValid({ providerID, modelID })) {
            return {
              providerID,
              modelID,
            }
          }
        }

        for (const item of modelStore.recent) {
          if (isModelValid(item)) {
            return item
          }
        }

        const provider = sync.data.provider[0]
        if (!provider) return undefined
        const defaultModel = sync.data.provider_default[provider.id]
        const firstModel = Object.values(provider.models)[0]
        const model = defaultModel ?? firstModel?.id
        if (!model) return undefined
        return {
          providerID: provider.id,
          modelID: model,
        }
      })

      const currentModel = createMemo(() => {
        const a = agent.current()
        return (
          getFirstValidModel(
            () => modelStore.model[a.name],
            () => a.model,
            fallbackModel,
          ) ?? undefined
        )
      })

      return {
        current: currentModel,
        get ready() {
          return modelStore.ready
        },
        recent() {
          return modelStore.recent
        },
        favorite() {
          return modelStore.favorite
        },
        /**
         * Resolved favorite models with full provider/model info. Filters out
         * favorites whose provider or model is no longer available, so the UI
         * does not have to defensively check.
         */
        favoriteResolved() {
          return modelStore.favorite
            .map((fav) => {
              const provider = sync.data.provider.find((x) => x.id === fav.providerID)
              const info = provider?.models[fav.modelID]
              if (!provider || !info) return undefined
              return {
                providerID: fav.providerID,
                modelID: fav.modelID,
                providerName: provider.name,
                modelName: info.name,
                reasoning: info.capabilities?.reasoning ?? false,
              }
            })
            .filter((x): x is NonNullable<typeof x> => x !== undefined)
        },
        /**
         * Rough USD cost estimate for a text payload against the current model.
         * Token count uses a 4-chars-per-token heuristic; cost is per-million tokens.
         * Returns undefined if no model is selected or no pricing is available.
         */
        estimateCost(text: string): { input: number; total: number } | undefined {
          const m = currentModel()
          if (!m) return undefined
          const provider = sync.data.provider.find((x) => x.id === m.providerID)
          const info = provider?.models[m.modelID]
          const costInput = info?.cost?.input
          if (typeof costInput !== "number" || costInput <= 0) return undefined
          const tokens = Math.max(1, Math.ceil(text.length / 4))
          const usd = (tokens / 1_000_000) * costInput
          return { input: usd, total: usd }
        },
        parsed: createMemo(() => {
          const value = currentModel()
          if (!value) {
            return {
              provider: "Connect a provider",
              model: "No provider selected",
              reasoning: false,
            }
          }
          const provider = sync.data.provider.find((x) => x.id === value.providerID)
          const info = provider?.models[value.modelID]
          return {
            provider: provider?.name ?? value.providerID,
            model: info?.name ?? value.modelID,
            reasoning: info?.capabilities?.reasoning ?? false,
          }
        }),
        cycle(direction: 1 | -1) {
          const current = currentModel()
          if (!current) return
          const recent = modelStore.recent
          const index = recent.findIndex((x) => x.providerID === current.providerID && x.modelID === current.modelID)
          if (index === -1) return
          const next = moveSelection(index, { count: recent.length, delta: direction, policy: "wrap" })
          const val = recent[next]
          if (!val) return
          setModelStore("model", agent.current().name, { ...val })
        },
        cycleFavorite(direction: 1 | -1) {
          const favorites = modelStore.favorite.filter((item) => isModelValid(item))
          if (!favorites.length) {
            toast.show({
              variant: "info",
              message: "Add a favorite model to use this shortcut",
              duration: 3000,
            })
            return
          }
          const current = currentModel()
          let index = -1
          if (current) {
            index = favorites.findIndex((x) => x.providerID === current.providerID && x.modelID === current.modelID)
          }
          if (index === -1) {
            index = direction === 1 ? 0 : favorites.length - 1
          } else {
            index += direction
            if (index < 0) index = favorites.length - 1
            if (index >= favorites.length) index = 0
          }
          const next = favorites[index]
          if (!next) return
          setModelStore("model", agent.current().name, { ...next })
          const uniq = uniqueBy([next, ...modelStore.recent], (x) => `${x.providerID}/${x.modelID}`)
          if (uniq.length > 10) uniq.pop()
          setModelStore(
            "recent",
            uniq.map((x) => ({ providerID: x.providerID, modelID: x.modelID })),
          )
          save()
        },
        set(model: { providerID: string; modelID: string }, options?: { recent?: boolean }) {
          batch(() => {
            if (!isModelValid(model)) {
              toast.show({
                message: `Model ${model.providerID}/${model.modelID} is not valid`,
                variant: "warning",
                duration: 3000,
              })
              return
            }
            setModelStore("model", agent.current().name, model)
            if (options?.recent) {
              const uniq = uniqueBy([model, ...modelStore.recent], (x) => `${x.providerID}/${x.modelID}`)
              if (uniq.length > 10) uniq.pop()
              setModelStore(
                "recent",
                uniq.map((x) => ({ providerID: x.providerID, modelID: x.modelID })),
              )
              save()
            }
          })
        },
        toggleFavorite(model: { providerID: string; modelID: string }) {
          batch(() => {
            if (!isModelValid(model)) {
              toast.show({
                message: `Model ${model.providerID}/${model.modelID} is not valid`,
                variant: "warning",
                duration: 3000,
              })
              return
            }
            const exists = modelStore.favorite.some(
              (x) => x.providerID === model.providerID && x.modelID === model.modelID,
            )
            const next = exists
              ? modelStore.favorite.filter((x) => x.providerID !== model.providerID || x.modelID !== model.modelID)
              : [model, ...modelStore.favorite]
            setModelStore(
              "favorite",
              next.map((x) => ({ providerID: x.providerID, modelID: x.modelID })),
            )
            save()
          })
        },
        variant: {
          current() {
            const m = currentModel()
            if (!m) return undefined
            const key = `${m.providerID}/${m.modelID}`
            return modelStore.variant[key]
          },
          /**
           * Returns the explicit variant if set, otherwise the first available
           * variant for the current model. Useful for "default for new users".
           */
          currentOrDefault() {
            const explicit = this.current()
            if (explicit) return explicit
            const list = this.list()
            return list[0]
          },
          list() {
            const m = currentModel()
            if (!m) return []
            const provider = sync.data.provider.find((x) => x.id === m.providerID)
            const info = provider?.models[m.modelID]
            if (!info?.variants) return []
            return Object.keys(info.variants)
          },
          set(value: string | undefined) {
            const m = currentModel()
            if (!m) return
            const key = `${m.providerID}/${m.modelID}`
            setModelStore("variant", key, value)
            save()
          },
          cycle() {
            const variants = this.list()
            if (variants.length === 0) return
            const current = this.current()
            if (!current) {
              this.set(variants[0])
              return
            }
            const index = variants.indexOf(current)
            if (index === -1 || index === variants.length - 1) {
              this.set(undefined)
              return
            }
            this.set(variants[index + 1])
          },
        },
      }
    })

    const mcp = {
      isEnabled(name: string) {
        const status = sync.data.mcp[name]
        return status?.status === "connected"
      },
      /** Names of MCP servers currently in the "connected" state. */
      connected() {
        return Object.entries(sync.data.mcp)
          .filter(([, status]) => status?.status === "connected")
          .map(([name]) => name)
      },
      /** Names of MCP servers currently in a "failed" state. */
      failed() {
        return Object.entries(sync.data.mcp)
          .filter(([, status]) => status?.status === "failed")
          .map(([name]) => name)
      },
      async toggle(name: string) {
        const status = sync.data.mcp[name]
        if (status?.status === "connected") {
          // Disable: disconnect the MCP
          await sdk.client.mcp.disconnect({ name })
        } else {
          // Enable/Retry: connect the MCP (handles disabled, failed, and other states)
          await sdk.client.mcp.connect({ name })
        }
      },
    }

    const connectors = {
      isEnabled(name: string) {
        const entry = sync.data.config.connectors?.[name]
        if (!entry || typeof entry !== "object" || !("type" in entry)) return false
        return entry.enabled !== false
      },
      /**
       * List all configured connectors (enabled and disabled). For surfacing in
       * a `/connectors` command or a settings tab.
       */
      list() {
        const map = sync.data.config.connectors
        if (!map || typeof map !== "object") return []
        return Object.entries(map)
          .filter(([, entry]) => entry && typeof entry === "object" && "type" in entry)
          .map(([name, entry]) => ({
            name,
            enabled: (entry as { enabled?: boolean }).enabled !== false,
            type: (entry as { type: string }).type,
          }))
      },
      async toggle(name: string) {
        const entry = sync.data.config.connectors?.[name]
        if (!entry || typeof entry !== "object" || !("type" in entry)) {
          toast.show({
            variant: "warning",
            message: `Connector not found: ${name}`,
            duration: 3000,
          })
          return
        }
        const nextEnabled = entry.enabled === false
        const nextConfig = {
          ...sync.data.config,
          connectors: {
            ...sync.data.config.connectors,
            [name]: {
              ...entry,
              enabled: nextEnabled,
            },
          },
        }
        await sdk.client.config.update({ payload: { connectors: nextConfig.connectors } })
        sync.set("config", nextConfig)
      },
      async auth(
        name: string,
        payload: {
          token?: string
          botToken?: string
          apiKey?: string
          teamId?: string
        },
      ) {
        await sdk.client.connectors.auth.set({ name, ...payload })
      },
      async logout(name: string) {
        await sdk.client.connectors.auth.remove({ name })
      },
    }

    const session = iife(() => {
      const [sessionStore, setSessionStore] = createStore<{
        ready: boolean
        pinned: string[]
      }>({
        ready: false,
        pinned: [],
      })

      const file = Bun.file(path.join(Global.Path.state, "session.json"))
      const state = {
        pending: false,
      }

      function save() {
        if (!sessionStore.ready) {
          state.pending = true
          return
        }
        state.pending = false
        Bun.write(
          file,
          JSON.stringify({
            pinned: sessionStore.pinned,
          }),
        )
      }

      file
        .json()
        .then((x) => {
          if (Array.isArray(x.pinned)) setSessionStore("pinned", x.pinned)
        })
        .catch(() => {})
        .finally(() => {
          setSessionStore("ready", true)
          if (state.pending) save()
        })

      const route = useRoute()
      const sdk = useSDK()

      const slots = createMemo(() => {
        const existing = new Set(sync.data.session.filter((x) => x.parentID === undefined).map((x) => x.id))
        return sessionStore.pinned.filter((id) => existing.has(id)).slice(0, 9)
      })

      /**
       * Most-recently-updated non-archived session, with `time.updated` parsed.
       * Returns undefined if there are no sessions. Used by the "Continue where
       * you left off" banner on the home route.
       */
      const mostRecent = createMemo(() => {
        const sessions = sync.data.session.filter((x) => x.parentID === undefined)
        if (sessions.length === 0) return undefined
        const sorted = [...sessions].sort((a, b) => (b.time?.updated ?? 0) - (a.time?.updated ?? 0))
        const top = sorted[0]
        if (!top) return undefined
        return { id: top.id, title: top.title, updated: top.time?.updated ?? 0 }
      })

      /** Total number of top-level (non-archived, non-child) sessions. */
      const count = createMemo(() => sync.data.session.filter((x) => x.parentID === undefined).length)

      /** True when there are no top-level sessions. */
      const empty = createMemo(() => count() === 0)

      /** Number of slots currently populated from the pinned list. */
      const pinnedCount = createMemo(() => slots().length)

      function prune(sessionID: string) {
        batch(() => {
          if (sessionStore.pinned.includes(sessionID)) {
            setSessionStore(
              "pinned",
              sessionStore.pinned.filter((x) => x !== sessionID),
            )
          }
          save()
        })
      }

      // Clean up pinned session when session is deleted
      sdk.event.on("session.deleted" as any, (evt: any) => {
        prune(evt.details?.info?.id)
      })

      return {
        get ready() {
          return sessionStore.ready
        },
        pinned() {
          return sessionStore.pinned
        },
        slots,
        count,
        empty,
        pinnedCount,
        mostRecent,
        isPinned(sessionID: string) {
          return sessionStore.pinned.includes(sessionID)
        },
        togglePin(sessionID: string) {
          batch(() => {
            const exists = sessionStore.pinned.includes(sessionID)
            const next = exists
              ? sessionStore.pinned.filter((x) => x !== sessionID)
              : [...sessionStore.pinned, sessionID]
            setSessionStore("pinned", next)
            save()
          })
        },
        quickSwitch(slot: number) {
          const target = slots()[slot - 1]
          if (!target) return
          if (route.data.type === "session" && route.data.sessionID === target) return
          route.navigate({ type: "session", sessionID: target })
        },
      }
    })

    // Automatically update model when agent changes
    createEffect(
      on(
        () => agent.current(),
        (value) => {
          if (value.model) {
            if (isModelValid(value.model))
              model.set({
                providerID: value.model.providerID,
                modelID: value.model.modelID,
              })
            else
              toast.show({
                variant: "warning",
                message: `Agent ${value.name}'s configured model ${value.model.providerID}/${value.model.modelID} is not valid`,
                duration: 3000,
              })
          }
        },
        { defer: true },
      ),
    )

    const result = {
      model,
      agent,
      mcp,
      connectors,
      session,
    }
    return result
  },
})
