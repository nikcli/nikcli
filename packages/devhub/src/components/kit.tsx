import { For, Show, createMemo, type JSX } from "solid-js"
import { Card } from "@nikcli-ai/ui/card"
import { Spinner } from "@nikcli-ai/ui/spinner"

export function Spark(props: {
  values: number[]
  height?: number
  max?: number
  min?: number
  color?: string
  fill?: boolean
}) {
  const W = 200
  const geom = createMemo(() => {
    const h = props.height ?? 40
    const v = props.values
    if (v.length < 2) return { line: "", area: "", h }
    const max = props.max ?? Math.max(...v, 1)
    const min = props.min ?? Math.min(0, ...v)
    const span = max - min || 1
    const pts = v.map((x, i) => [(i / (v.length - 1)) * W, h - 2 - ((x - min) / span) * (h - 4)] as const)
    const line = pts.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`).join(" ")
    return { line, area: `${line} L${W} ${h} L0 ${h} Z`, h }
  })
  const gid = `dh-g${Math.random().toString(36).slice(2, 8)}`
  return (
    <svg
      class="dh-spark"
      viewBox={`0 0 ${W} ${geom().h}`}
      preserveAspectRatio="none"
      style={{ height: `${geom().h}px`, color: props.color ?? "var(--icon-strong-base)" }}
    >
      <Show when={props.fill !== false && geom().area}>
        <defs>
          <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stop-color="currentColor" stop-opacity="0.28" />
            <stop offset="1" stop-color="currentColor" stop-opacity="0" />
          </linearGradient>
        </defs>
        <path d={geom().area} fill={`url(#${gid})`} />
      </Show>
      <path d={geom().line} fill="none" stroke="currentColor" stroke-width="1.5" vector-effect="non-scaling-stroke" />
    </svg>
  )
}

export function Stat(props: {
  label: string
  value: JSX.Element
  hint?: JSX.Element
  spark?: number[]
  sparkMax?: number
  tone?: "ok" | "warn" | "bad"
}) {
  return (
    <Card class="dh-stat" data-tone={props.tone}>
      <div class="dh-stat__label">{props.label}</div>
      <div class="dh-stat__value">{props.value}</div>
      <Show when={props.hint}>
        <div class="dh-stat__hint">{props.hint}</div>
      </Show>
      <Show when={props.spark && props.spark.length > 1}>
        <Spark values={props.spark!} max={props.sparkMax} height={28} />
      </Show>
    </Card>
  )
}

export function Bar(props: { value: number; tone?: "ok" | "warn" | "bad" }) {
  const tone = () => props.tone ?? (props.value > 90 ? "bad" : props.value > 70 ? "warn" : "ok")
  return (
    <div class="dh-bar" data-tone={tone()}>
      <div style={{ width: `${Math.max(0, Math.min(100, props.value))}%` }} />
    </div>
  )
}

export function Panel(props: { title: string; actions?: JSX.Element; children: JSX.Element; class?: string }) {
  return (
    <section class={`dh-panel ${props.class ?? ""}`}>
      <header>
        <h3>{props.title}</h3>
        <div class="dh-panel__actions">{props.actions}</div>
      </header>
      <div class="dh-panel__body">{props.children}</div>
    </section>
  )
}

export function Page(props: { title: string; subtitle?: JSX.Element; actions?: JSX.Element; children: JSX.Element }) {
  return (
    <div class="dh-page">
      <header class="dh-page__head">
        <div>
          <h1>{props.title}</h1>
          <Show when={props.subtitle}>
            <p>{props.subtitle}</p>
          </Show>
        </div>
        <div class="dh-page__actions">{props.actions}</div>
      </header>
      {props.children}
    </div>
  )
}

export function Loading(props: { label?: string }) {
  return (
    <div class="dh-empty">
      <Spinner />
      <span>{props.label ?? "Loading…"}</span>
    </div>
  )
}

export function Problem(props: { error?: string; title?: string }) {
  return (
    <Show when={props.error}>
      <Card variant="error" class="dh-problem">
        <strong>{props.title ?? "Request failed"}</strong>
        <span>{props.error}</span>
      </Card>
    </Show>
  )
}

export function Empty(props: { children: JSX.Element }) {
  return <div class="dh-empty">{props.children}</div>
}

export function KV(props: { rows: [string, JSX.Element][] }) {
  return (
    <dl class="dh-kv">
      <For each={props.rows}>
        {([k, v]) => (
          <>
            <dt>{k}</dt>
            <dd>{v}</dd>
          </>
        )}
      </For>
    </dl>
  )
}

export function Dot(props: { tone: "ok" | "warn" | "bad" | "idle"; live?: boolean }) {
  return <span class="dh-dot" data-tone={props.tone} data-live={props.live ? "" : undefined} />
}
