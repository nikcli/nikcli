import { createEffect, createMemo, createRoot, createSignal, on, onCleanup } from "solid-js"
import { native, type StreamEvent } from "./native"
import { app } from "./store"

/** One span published by nikcli's observability layer (`telemetry.record` on the event bus). */
export type Span = {
  id: string
  traceId: string
  parentId?: string
  name: string
  kind: string
  startTime: number
  durationMs: number
  statusCode?: number
  statusMessage?: string
  attributes?: Record<string, string>
  directory?: string
}

export type FeedEvent = { at: number; type: string; directory?: string; sessionID?: string; summary: string }
export type StreamState = "idle" | "connecting" | "live" | "reconnecting" | "error"

const MAX_SPANS = 4000
const MAX_FEED = 1500

function summarize(type: string, p: Record<string, unknown>): string {
  const s = (v: unknown) => (typeof v === "string" ? v : undefined)
  const part = p.part as { type?: string; tool?: string; text?: string } | undefined
  if (type === "message.part.updated" && part)
    return part.type === "tool" ? `tool ${part.tool ?? ""}` : (part.type ?? "part")
  const info = p.info as { role?: string; modelID?: string } | undefined
  if (type.startsWith("message.updated") && info) return `${info.role ?? ""} ${info.modelID ?? ""}`.trim()
  return s(p.sessionID) ?? s(p.title) ?? s(p.name) ?? ""
}

function createEvents() {
  const [spans, setSpans] = createSignal<Span[]>([])
  const [feed, setFeed] = createSignal<FeedEvent[]>([])
  const [state, setState] = createSignal<StreamState>("idle")
  const [detail, setDetail] = createSignal<string>()
  const [counts, setCounts] = createSignal<Record<string, number>>({})
  const [total, setTotal] = createSignal(0)
  const [paused, setPaused] = createSignal(false)
  // events/second for the last 60 s, one bucket per second
  const [rate, setRate] = createSignal<number[]>(new Array(60).fill(0))
  let bucket = 0
  let queue: { spans: Span[]; feed: FeedEvent[]; counts: Record<string, number> } = { spans: [], feed: [], counts: {} }
  let scheduled = false

  const flush = () => {
    scheduled = false
    const q = queue
    queue = { spans: [], feed: [], counts: {} }
    if (paused()) return
    if (q.spans.length) setSpans((s) => [...s, ...q.spans].slice(-MAX_SPANS))
    if (q.feed.length) setFeed((f) => [...f, ...q.feed].slice(-MAX_FEED))
    setCounts((c) => {
      const next = { ...c }
      for (const [k, v] of Object.entries(q.counts)) next[k] = (next[k] ?? 0) + v
      return next
    })
  }

  const onEvent = (e: StreamEvent) => {
    if (e.kind === "connection") {
      setState(e.state)
      setDetail(e.detail ?? undefined)
      return
    }
    const { payload, directory } = e.data
    if (!payload?.type) return
    bucket++
    setTotal((t) => t + 1)
    queue.counts[payload.type] = (queue.counts[payload.type] ?? 0) + 1
    if (payload.type === "telemetry.record") queue.spans.push({ ...(payload.properties as unknown as Span), directory })
    else if (payload.type !== "server.connected") {
      const props = payload.properties ?? {}
      queue.feed.push({
        at: Date.now(),
        type: payload.type,
        directory,
        sessionID: typeof props.sessionID === "string" ? props.sessionID : undefined,
        summary: summarize(payload.type, props),
      })
    }
    if (!scheduled) ((scheduled = true), setTimeout(flush, 120))
  }

  const tick = setInterval(() => {
    setRate((r) => [...r.slice(1), bucket])
    bucket = 0
  }, 1000)
  onCleanup(() => clearInterval(tick))

  // One stream per selected service; switching service tears the old one down first.
  const url = createMemo(() => (app.service()?.alive ? app.service()!.url : undefined))
  createEffect(
    on(url, (u) => {
      void native.eventStop("global").catch(() => undefined)
      setSpans([])
      setFeed([])
      setCounts({})
      setTotal(0)
      if (!u) return setState("idle")
      setState("connecting")
      native.eventStream("global", u, "/global/event", onEvent).catch((e) => {
        setState("error")
        setDetail(String(e))
      })
    }),
  )

  return {
    spans,
    feed,
    state,
    detail,
    counts,
    total,
    rate,
    paused,
    setPaused,
    clear: () => (setSpans([]), setFeed([]), setCounts({}), setTotal(0)),
  }
}

export const events = createRoot(createEvents)

// ── pure analytics over spans ────────────────────────────────────────────────

export const isError = (s: Span) => (s.statusCode ?? 0) === 2 || (s.statusCode ?? 0) >= 400

export function quantile(sorted: number[], q: number) {
  return sorted.length ? sorted[Math.max(0, Math.ceil(q * sorted.length) - 1)] : 0
}

export type OpStat = {
  name: string
  kind: string
  count: number
  errors: number
  total: number
  mean: number
  p50: number
  p95: number
  max: number
}

export function aggregate(spans: readonly Span[]): OpStat[] {
  const by = new Map<string, Span[]>()
  for (const s of spans) by.set(s.name, [...(by.get(s.name) ?? []), s])
  return [...by.entries()]
    .map(([name, list]) => {
      const d = list.map((s) => s.durationMs).sort((a, b) => a - b)
      const total = d.reduce((a, b) => a + b, 0)
      return {
        name,
        kind: list[0].kind,
        count: list.length,
        errors: list.filter(isError).length,
        total,
        mean: total / list.length,
        p50: quantile(d, 0.5),
        p95: quantile(d, 0.95),
        max: d[d.length - 1],
      }
    })
    .sort((a, b) => b.total - a.total)
}

export type TraceNode = { span: Span; depth: number; offset: number }

/** Spans of one trace ordered as a tree (parents before children, siblings by start time). */
export function traceTree(all: readonly Span[], traceId: string): { nodes: TraceNode[]; start: number; end: number } {
  const spans = all.filter((s) => s.traceId === traceId).sort((a, b) => a.startTime - b.startTime)
  if (!spans.length) return { nodes: [], start: 0, end: 0 }
  const ids = new Set(spans.map((s) => s.id))
  const kids = new Map<string | undefined, Span[]>()
  for (const s of spans) {
    const key = s.parentId && ids.has(s.parentId) ? s.parentId : undefined
    kids.set(key, [...(kids.get(key) ?? []), s])
  }
  const start = Math.min(...spans.map((s) => s.startTime))
  const end = Math.max(...spans.map((s) => s.startTime + s.durationMs))
  const nodes: TraceNode[] = []
  const walk = (parent: string | undefined, depth: number) => {
    for (const s of kids.get(parent) ?? []) {
      nodes.push({ span: s, depth, offset: s.startTime - start })
      walk(s.id, depth + 1)
    }
  }
  walk(undefined, 0)
  return { nodes, start, end }
}
