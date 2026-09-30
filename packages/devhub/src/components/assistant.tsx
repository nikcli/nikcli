import { shortcut } from "../lib/platform"
import { For, Match, Show, Switch as SolidSwitch, createEffect, createMemo, createSignal, onMount } from "solid-js"
import { Button } from "@nikcli-ai/ui/button"
import { IconButton } from "@nikcli-ai/ui/icon-button"
import { Icon } from "@nikcli-ai/ui/icon"
import { Markdown } from "@nikcli-ai/ui/markdown"
import { Select } from "@nikcli-ai/ui/select"
import { Spinner } from "@nikcli-ai/ui/spinner"
import { Switch } from "@nikcli-ai/ui/switch"
import { assistant, type Card } from "../lib/assistant"
import { createAgents, createModels, modelKey, type AgentOption, type ModelOption } from "../lib/models"
import { app } from "../lib/store"
import { bytes, duration, ms } from "../lib/format"
import { textOf, type ChatMessage, type Part } from "../lib/agent"

const SUGGESTIONS = [
  "Quanta memoria usa nikcli adesso e quale processo pesa di più?",
  "Lancia i test del pacchetto httpapi-codegen e dimmi cosa è lento",
  "Crea un benchmark che confronta JSON.parse e structuredClone su un oggetto da 10k chiavi",
  "Sonda la latenza delle route e confrontala con la baseline",
]

const ICON: Record<string, string> = {
  navigate: "arrow-right",
  snapshot: "server",
  processes: "server",
  runs: "task",
  list_tests: "checklist",
  run_tests: "checklist",
  run_script: "code",
  run_bench: "task",
  http: "link",
  model_bench: "models",
  kill: "circle-x",
}

function describe(c: Card): string {
  const a = c.action
  if (!a) return "invalid action"
  switch (a.action) {
    case "navigate":
      return `Go to ${a.page}`
    case "snapshot":
      return "Read system snapshot"
    case "processes":
      return `List processes${a.category ? ` · ${a.category}` : ""}`
    case "runs":
      return "List recent runs"
    case "list_tests":
      return `List tests · ${a.package}${a.filter ? ` · “${a.filter}”` : ""}`
    case "run_tests":
      return `Run tests · ${a.package}${a.files?.length ? ` · ${a.files.length} file(s)` : " · all"}${a.pattern ? ` · -t ${a.pattern}` : ""}`
    case "run_script":
      return `Run ${a.kind === "test" ? "test" : "benchmark"} script${a.name ? ` · ${a.name}` : ""}`
    case "run_bench":
      return a.target === "suite" ? "Run benchmark suite" : `Probe routes · ${a.samples ?? 30} samples`
    case "http":
      return `${(a.method ?? "GET").toUpperCase()} ${a.path}`
    case "model_bench":
      return `Benchmark ${a.models.length} model(s) × ${a.runs ?? 3} runs`
    case "kill":
      return `${a.force ? "Kill" : "Terminate"} pid ${a.pid}`
  }
}

function ActionCard(props: { card: Card }) {
  const c = () => props.card
  const confirmKill = () => {
    const a = c().action
    if (a?.action === "kill" && !confirm(`${a.force ? "Force kill" : "Terminate"} pid ${a.pid}?`)) return
    void assistant.run(c().key)
  }
  return (
    <div class="dh-action" data-status={c().status}>
      <div class="dh-action__row">
        <Icon name={(ICON[c().action?.action ?? ""] ?? "code") as never} size="small" />
        <span class="dh-action__title">{describe(c())}</span>
        <span class="dh-action__state">
          <SolidSwitch>
            <Match when={c().status === "running"}>
              <Spinner /> running
            </Match>
            <Match when={c().status === "done"}>done{c().ms ? ` · ${ms(c().ms!)}` : ""}</Match>
            <Match when={c().status === "error"}>failed</Match>
            <Match when={c().status === "skipped"}>skipped</Match>
          </SolidSwitch>
        </span>
      </div>
      <Show when={c().status === "pending"}>
        <div class="dh-action__buttons">
          <Button
            size="small"
            variant="primary"
            onClick={() => (c().action?.action === "kill" ? confirmKill() : void assistant.run(c().key))}
          >
            Run
          </Button>
          <Button size="small" variant="ghost" onClick={() => void assistant.skip(c().key)}>
            Skip
          </Button>
        </div>
      </Show>
      <Show when={c().status === "error" && c().error}>
        <div class="dh-action__error">{c().error}</div>
      </Show>
      <Show when={c().result}>
        <details class="dh-action__details">
          <summary>{c().result!.title}</summary>
          <pre>{c().result!.output}</pre>
        </details>
      </Show>
      <Show when={c().action?.action === "run_script"}>
        <details class="dh-action__details">
          <summary>script</summary>
          <pre>{(c().action as { code: string }).code}</pre>
        </details>
      </Show>
    </div>
  )
}

function Reasoning(props: { parts: readonly Part[] }) {
  const text = () =>
    props.parts
      .filter((p) => p.type === "reasoning" && p.text)
      .map((p) => p.text)
      .join("\n\n")
  return (
    <Show when={text()}>
      <details class="dh-reasoning">
        <summary>Thinking</summary>
        <p>{text()}</p>
      </details>
    </Show>
  )
}

function ToolLines(props: { parts: readonly Part[] }) {
  const tools = () => props.parts.filter((p) => p.type === "tool")
  return (
    <Show when={tools().length}>
      <div class="dh-tools">
        <For each={tools()}>
          {(t) => (
            <span class="dh-tool" data-status={t.state?.status}>
              <Show
                when={t.state?.status === "running" || t.state?.status === "pending"}
                fallback={<Icon name="check-small" size="small" />}
              >
                <Spinner />
              </Show>
              {t.tool}
              <Show when={t.state?.title}> · {t.state!.title}</Show>
            </span>
          )}
        </For>
      </div>
    </Show>
  )
}

function Meta(props: { message: ChatMessage }) {
  const i = () => props.message.info
  const took = () => (i().time.completed ? (i().time.completed! - i().time.created) / 1000 : undefined)
  return (
    <div class="dh-meta">
      <Show when={i().modelID}>
        <span>{i().modelID}</span>
      </Show>
      <Show when={took() !== undefined}>
        <span>{duration(took()!)}</span>
      </Show>
      <Show when={i().tokens}>
        <span>
          {(i().tokens!.input + i().tokens!.output + i().tokens!.reasoning + i().tokens!.cache.read).toLocaleString()}{" "}
          tok
        </span>
      </Show>
      <Show when={i().cost}>
        <span>${i().cost!.toFixed(4)}</span>
      </Show>
    </div>
  )
}

export function Assistant() {
  const { models } = createModels()
  const agents = createAgents()
  const [draft, setDraft] = createSignal("")
  let scroller: HTMLDivElement | undefined
  let input: HTMLTextAreaElement | undefined
  const [stick, setStick] = createSignal(true)

  onMount(() => void assistant.resume())

  createEffect(() => {
    assistant.items()
    assistant.busy()
    Object.keys(assistant.cards).length
    queueMicrotask(() => stick() && scroller && (scroller.scrollTop = scroller.scrollHeight))
  })
  createEffect(() => assistant.open() && queueMicrotask(() => input?.focus()))

  const send = () => {
    const text = draft().trim()
    if (!text || assistant.busy()) return
    setDraft("")
    setStick(true)
    void assistant.send(text)
    if (input) input.style.height = ""
  }
  const grow = (el: HTMLTextAreaElement) => {
    el.style.height = "auto"
    el.style.height = `${Math.min(el.scrollHeight, 180)}px`
  }
  const current = createMemo(() =>
    models().find((m) => assistant.model() && modelKey(m) === modelKey(assistant.model()!)),
  )
  const ownProcs = () =>
    app.snapshot()?.procs.filter((p) => ["service", "server", "cli", "test", "dev", "child"].includes(p.category)) ?? []
  const rss = () => ownProcs().reduce((a, p) => a + p.rss, 0)
  const live = createMemo(() => {
    if (!assistant.busy()) return undefined
    const last = assistant.items().at(-1)
    if (last?.kind !== "assistant") return "Thinking…"
    const running = last.message.parts.find(
      (p) => p.type === "tool" && (p.state?.status === "running" || p.state?.status === "pending"),
    )
    return running ? `Running ${running.tool}…` : last.text ? "Writing…" : "Thinking…"
  })

  return (
    <aside class="dh-assistant" data-open={assistant.open()} aria-hidden={!assistant.open()} inert={!assistant.open()}>
      <header class="dh-assistant__head">
        <div class="dh-assistant__title">
          <span class="dh-assistant__glyph" aria-hidden="true" />
          <div>
            <h2>Assistant</h2>
            <p>
              nikcli · {assistant.agent()} agent · sees {assistant.page()}
            </p>
          </div>
        </div>
        <div class="dh-assistant__tools">
          <IconButton
            icon="plus-small"
            variant="ghost"
            aria-label="New chat"
            title="New chat"
            onClick={() => assistant.reset()}
          />
          <IconButton
            icon="close-small"
            variant="ghost"
            aria-label="Close assistant"
            title={`Close (${shortcut("J")})`}
            onClick={() => assistant.setOpen(false)}
          />
        </div>
      </header>

      <div class="dh-assistant__opts">
        <Select<ModelOption | undefined>
          size="small"
          variant="ghost"
          options={[undefined, ...models()]}
          current={current()}
          value={(m) => (m ? modelKey(m) : "default")}
          label={(m) => (m ? `${m.name}` : "Default model")}
          groupBy={(m) => (m ? m.providerName : "Automatic")}
          onSelect={(m) => assistant.setModel(m ? { providerID: m.providerID, modelID: m.modelID } : undefined)}
          placeholder="Default model"
        />
        <Select<AgentOption>
          size="small"
          variant="ghost"
          options={agents()}
          current={agents().find((a) => a.name === assistant.agent())}
          value={(a) => a.name}
          label={(a) => a.name}
          onSelect={(a) => a && assistant.setAgent(a.name)}
          placeholder="build"
        />
        <Switch
          checked={assistant.autoApprove()}
          onChange={assistant.setAuto}
          title="Run actions without asking — killing a process always asks"
        >
          Auto-run
        </Switch>
      </div>

      <div class="dh-assistant__context" title="Sent with every message">
        <span>{app.service() ? `${app.service()!.channel} · v${app.service()!.version}` : "no service"}</span>
        <span>
          {ownProcs().length} procs · {bytes(rss())}
        </span>
        <span>{assistant.page()}</span>
      </div>

      <div
        class="dh-assistant__scroll"
        ref={scroller}
        onScroll={() => scroller && setStick(scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 40)}
      >
        <Show
          when={assistant.items().length}
          fallback={
            <div class="dh-assistant__empty">
              <div class="dh-hero">
                <span class="dh-assistant__glyph" aria-hidden="true" />
                Cosa vuoi fare con nikcli?
              </div>
              <p>
                Chiedimi qualsiasi cosa su nikcli e su questa app: processi, memoria, test, benchmark, API. Posso anche
                scrivere ed eseguire un benchmark a partire da una descrizione.
              </p>
              <div class="dh-suggest">
                <For each={SUGGESTIONS}>
                  {(s) => (
                    <button onClick={() => void assistant.send(s)} disabled={assistant.busy()}>
                      {s}
                    </button>
                  )}
                </For>
              </div>
            </div>
          }
        >
          <For each={assistant.items()}>
            {(item) => (
              <SolidSwitch>
                <Match when={item.kind === "user"}>
                  <div class="dh-msg dh-msg--user">{item.text}</div>
                </Match>
                <Match when={item.kind === "results"}>
                  <details class="dh-msg dh-msg--results">
                    <summary>Action results sent to the assistant</summary>
                    <pre>{item.text}</pre>
                  </details>
                </Match>
                <Match when={item.kind === "assistant"}>
                  <div class="dh-msg dh-msg--assistant">
                    <Reasoning parts={item.message.parts} />
                    <ToolLines parts={item.message.parts} />
                    <Show when={item.text}>
                      <Markdown text={item.text} cacheKey={item.message.info.id} class="dh-md" />
                    </Show>
                    <For each={assistant.cardsOf(item.message.info.id)}>{(card) => <ActionCard card={card} />}</For>
                    <Show when={item.message.info.error}>
                      <div class="dh-action__error">
                        {item.message.info.error!.data?.message ?? item.message.info.error!.name}
                      </div>
                    </Show>
                    <Show when={item.message.info.time.completed}>
                      <Meta message={item.message} />
                    </Show>
                  </div>
                </Match>
              </SolidSwitch>
            )}
          </For>
        </Show>
        <Show when={live()}>
          <div class="dh-live">
            <Spinner />
            <span>{live()}</span>
            <Show when={assistant.depth() > 0}>
              <em>step {assistant.depth() + 1}</em>
            </Show>
          </div>
        </Show>
        <Show when={assistant.error()}>
          <div class="dh-action__error">{assistant.error()}</div>
        </Show>
      </div>

      <footer class="dh-assistant__composer">
        <textarea
          ref={input}
          rows={1}
          placeholder="Scrivi un comando o una domanda…"
          value={draft()}
          onInput={(e) => (setDraft(e.currentTarget.value), grow(e.currentTarget))}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
              e.preventDefault()
              send()
            }
          }}
        />
        <Show
          when={assistant.busy()}
          fallback={
            <IconButton icon="arrow-up" variant="primary" aria-label="Send" disabled={!draft().trim()} onClick={send} />
          }
        >
          <IconButton icon="stop" variant="primary" aria-label="Stop" onClick={() => void assistant.stop()} />
        </Show>
      </footer>
    </aside>
  )
}
