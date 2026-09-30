import { Effect, Layer } from "effect"
import { createMemo, createRoot, createSignal } from "solid-js"
import { createStore, produce } from "solid-js/store"
import { Agent, textOf, type ChatMessage, type ModelRef } from "./agent"
import {
  CONTEXT_BLOCK,
  Host,
  RESULTS_PREFIX,
  ASSISTANT_TOOLS,
  SYSTEM_PROMPT,
  alwaysConfirm,
  execute,
  isSafe,
  parseActions,
  renderContext,
  stripActions,
  wrapUserMessage,
  type Action,
  type ActionResult,
  type PageId,
} from "./actions"
import { errorText, native } from "./native"
import { runApp } from "./runtime"
import { app, toastError } from "./store"
import { runner } from "./tasks"

export type CardStatus = "pending" | "running" | "done" | "error" | "skipped"
export type Card = {
  key: string
  messageID: string
  index: number
  action?: Action
  raw: string
  invalid?: string
  status: CardStatus
  result?: ActionResult
  error?: string
  ms?: number
}

const LS = {
  session: "devhub.chat.session",
  model: "devhub.chat.model",
  agent: "devhub.chat.agent",
  auto: "devhub.chat.auto",
  open: "devhub.chat.open",
}
const read = <T>(k: string): T | undefined => {
  try {
    const v = localStorage.getItem(k)
    return v === null ? undefined : (JSON.parse(v) as T)
  } catch {
    return undefined
  }
}
const write = (k: string, v: unknown) => {
  try {
    v === undefined ? localStorage.removeItem(k) : localStorage.setItem(k, JSON.stringify(v))
  } catch {}
}

/** How many times the assistant may continue on its own from action results before it must wait for the user. */
const MAX_AUTO_TURNS = 6

function createAssistant() {
  const [page, setPage] = createSignal<PageId>((localStorage.getItem("devhub.page") as PageId) ?? "overview")
  const [navigate, setNavigate] = createSignal<(p: PageId) => void>(() => undefined)
  const [open, setOpenRaw] = createSignal(read<boolean>(LS.open) ?? false)
  const [sessionID, setSessionID] = createSignal<string | undefined>(read<string>(LS.session))
  const [messages, setMessages] = createSignal<readonly ChatMessage[]>([])
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal<string>()
  const [model, setModelRaw] = createSignal<ModelRef | undefined>(read<ModelRef>(LS.model))
  const [agent, setAgentRaw] = createSignal<string>(read<string>(LS.agent) ?? "build")
  const [autoApprove, setAutoRaw] = createSignal(read<boolean>(LS.auto) ?? false)
  const [cards, setCards] = createStore<Record<string, Card>>({})
  const [depth, setDepth] = createSignal(0)
  const handled = new Set<string>()
  let polling: ReturnType<typeof setInterval> | undefined

  const setOpen = (v: boolean) => (setOpenRaw(v), write(LS.open, v))
  const setModel = (m: ModelRef | undefined) => (setModelRaw(m), write(LS.model, m))
  const setAgent = (a: string) => (setAgentRaw(a), write(LS.agent, a))
  const setAuto = (v: boolean) => (setAutoRaw(v), write(LS.auto, v))

  // The Host port: DevHub's real state and tools, handed to the action executor.
  const hostLayer = Layer.succeed(
    Host,
    Host.of({
      navigate: (p) => navigate()(p),
      snapshot: () => app.snapshot(),
      tests: () => native.tests(),
      runs: () => runner.runs,
      runTask: async (input) => {
        const id = await runner.start(input)
        return runner.waitFor(id)
      },
      writeScratch: (n, c) => native.writeScratch(n, c),
      kill: async (pid, force) => {
        await native.kill(pid, force)
        void app.refreshNow()
      },
      repoRoot: () => app.repo(),
    }),
  )

  const context = () =>
    renderContext({
      page: page(),
      service: app.service() && {
        channel: app.service()!.channel,
        url: app.service()!.url,
        version: app.service()!.version,
        pid: app.service()!.pid,
      },
      repo: app.repo(),
      snapshot: app.snapshot(),
      runs: runner.runs,
    })

  const load = async (id: string) => {
    const list = await runApp(Agent.use((a) => a.messages(id)))
    setMessages(list)
    return list
  }

  const startPolling = (id: string) => {
    stopPolling()
    polling = setInterval(() => void load(id).catch(() => undefined), 900)
  }
  const stopPolling = () => polling && (clearInterval(polling), (polling = undefined))

  const ensureSession = async () => {
    const existing = sessionID()
    if (existing && (await runApp(Agent.use((a) => a.exists(existing))))) return existing
    const id = await runApp(Agent.use((a) => a.createSession("DevHub assistant")))
    setSessionID(id)
    write(LS.session, id)
    setMessages([])
    return id
  }

  /** Sends one turn and, when the reply holds actions, drives them. */
  const turn = async (text: string, automatic: boolean) => {
    if (busy()) return
    setBusy(true)
    setError(undefined)
    if (!automatic) setDepth(0)
    try {
      const id = await ensureSession()
      startPolling(id)
      const m = model()
      const reply = await runApp(
        Agent.use((a) =>
          a.prompt({
            sessionID: id,
            text: wrapUserMessage(context(), text),
            system: SYSTEM_PROMPT,
            model: m,
            agent: agent(),
            tools: ASSISTANT_TOOLS,
          }),
        ),
      )
      stopPolling()
      await load(id)
      await handleReply(reply)
    } catch (e) {
      stopPolling()
      setError(errorText(e))
      const id = sessionID()
      if (id) void load(id).catch(() => undefined)
    } finally {
      stopPolling()
      setBusy(false)
    }
  }

  const handleReply = async (reply: ChatMessage) => {
    if (handled.has(reply.info.id)) return
    handled.add(reply.info.id)
    const parsed = await Effect.runPromise(parseActions(textOf(reply)))
    if (!parsed.length) return
    const created: Card[] = parsed.map((p) => ({
      key: `${reply.info.id}:${p.index}`,
      messageID: reply.info.id,
      index: p.index,
      raw: p.raw,
      action: p.ok ? p.action : undefined,
      invalid: p.ok ? undefined : p.error,
      status: p.ok ? "pending" : "error",
      error: p.ok ? undefined : p.error,
    }))
    setCards(produce((all) => created.forEach((c) => (all[c.key] = c))))
    for (const c of created)
      if (c.action && (isSafe(c.action) || (autoApprove() && !alwaysConfirm(c.action)))) await run(c.key, true)
    await maybeContinue(reply.info.id)
  }

  const run = async (key: string, batch = false) => {
    const card = cards[key]
    if (!card?.action || card.status === "running") return
    setCards(key, { status: "running", error: undefined })
    const started = performance.now()
    try {
      const result = await runApp(execute(card.action).pipe(Effect.provide(hostLayer)))
      setCards(key, { status: "done", result, ms: performance.now() - started })
    } catch (e) {
      setCards(key, {
        status: "error",
        error: errorText(e).replace(/^.*ActionError:?\s*/, ""),
        ms: performance.now() - started,
      })
    }
    if (!batch) await maybeContinue(card.messageID)
  }

  const skip = async (key: string) => {
    const card = cards[key]
    if (!card || card.status !== "pending") return
    setCards(key, { status: "skipped" })
    await maybeContinue(card.messageID)
  }

  const cardsOf = (messageID: string) =>
    Object.values(cards)
      .filter((c) => c.messageID === messageID)
      .sort((a, b) => a.index - b.index)

  /** Once every action of a reply is settled and at least one ran, hand the results back to the model. */
  const maybeContinue = async (messageID: string) => {
    const list = cardsOf(messageID)
    if (!list.length || list.some((c) => c.status === "pending" || c.status === "running")) return
    if (list.every((c) => c.status === "skipped")) return
    if (depth() >= MAX_AUTO_TURNS) {
      setError(`Paused after ${MAX_AUTO_TURNS} automatic steps — send a message to continue.`)
      return
    }
    const body = list
      .map((c) => {
        const name = c.action?.action ?? "invalid action"
        if (c.status === "done") return `### ${c.result!.title}\n${c.result!.output}`
        if (c.status === "skipped") return `### ${name}\nskipped by the user`
        return `### ${name} failed\n${c.error ?? "unknown error"}`
      })
      .join("\n\n")
    setDepth((d) => d + 1)
    await turn(`${RESULTS_PREFIX}\n${body}`, true)
  }

  const stop = async () => {
    const id = sessionID()
    if (!id) return
    await runApp(Agent.use((a) => a.abort(id))).catch((e) => toastError("Could not stop", e))
  }

  const reset = () => {
    stopPolling()
    setSessionID(undefined)
    write(LS.session, undefined)
    setMessages([])
    setError(undefined)
    setDepth(0)
    handled.clear()
    setCards(produce((all) => Object.keys(all).forEach((k) => delete all[k])))
  }

  // Resume the previous conversation; its historical action blocks are shown as read-only text.
  const resume = async () => {
    const id = sessionID()
    if (!id) return
    try {
      const list = await load(id)
      for (const m of list) if (m.info.role === "assistant") handled.add(m.info.id)
    } catch {
      reset()
    }
  }

  const items = createMemo(() =>
    messages().map((m) => {
      const raw = textOf(m)
      if (m.info.role === "user") {
        const text = raw.replace(CONTEXT_BLOCK, "").trim()
        return {
          kind: (text.startsWith(RESULTS_PREFIX) ? "results" : "user") as "user" | "results",
          message: m,
          text: text.replace(RESULTS_PREFIX, "").trim(),
        }
      }
      return { kind: "assistant" as const, message: m, text: stripActions(raw) }
    }),
  )

  return {
    page,
    setPage,
    bindNavigate: (fn: (p: PageId) => void) => setNavigate(() => fn),
    open,
    setOpen,
    toggle: () => setOpen(!open()),
    busy,
    error,
    model,
    setModel,
    agent,
    setAgent,
    autoApprove,
    setAuto,
    items,
    cards,
    cardsOf,
    send: (text: string) => turn(text, false),
    run: (k: string) => run(k),
    skip,
    stop,
    reset,
    resume,
    depth,
    hostLayer,
  }
}

export const assistant = createRoot(createAssistant)
