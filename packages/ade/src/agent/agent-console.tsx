/**
 * The voice agent's own section: what it was asked, and what it did for us.
 *
 * Everything here comes from the engine's `history`, which is a list rather
 * than the last-value signals the HUD reads. The distinction matters: the HUD
 * answers "what is happening", and this panel has to answer "what happened",
 * which no amount of watching `lastSpoken` can do.
 *
 * The composer is not a second-class path. Speaking to the assistant and
 * typing to it reach the same `submitText`, so a plan can be given in a noisy
 * room, re-read before it runs, and corrected — none of which voice allows.
 *
 * No test mounts this file: a `.tsx` has no automatic JSX runtime under
 * `bun test` in this repo. The logic that would be worth asserting lives in
 * `./status.ts` and in `@nikcli-ai/voice`'s `agent/log.ts`, both imported here
 * and both tested directly.
 */

import { createEffect, createSignal, on, For, Show, onCleanup } from "solid-js"
import { groupIntoTurns, type AgentEntry, type AgentTurn } from "@nikcli-ai/voice"
import { presenceLabel, presenceOf } from "./status"
import "./agent-console.css"
import { t } from "../i18n"

export interface AgentConsoleProps {
  history: AgentEntry[]
  running: boolean
  status: string
  /** Live partial transcript, shown as the sentence still being spoken. */
  partial: string
  /** Whether a planner key is configured; without one, plans cannot be made. */
  canPlan: boolean
  /** A sentence heard while thinking and set aside, offered with a button to send it. */
  held?: string | null
  onSubmit: (text: string) => void
  onToggleMic: () => void
  onOpenSettings: () => void
}

function timeOf(at: number): string {
  if (!Number.isFinite(at) || at <= 0) return ""
  return new Date(at).toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit" })
}

export function AgentConsole(props: AgentConsoleProps) {
  const [draft, setDraft] = createSignal("")
  let scroller: HTMLDivElement | undefined
  let composer: HTMLTextAreaElement | undefined

  const turns = () => groupIntoTurns(props.history)
  const presence = () => presenceLabel(presenceOf({ running: props.running, status: props.status }))

  /*
   * Follow the tail, but only when the reader is already at it.
   *
   * Scrolling someone back to the bottom while they are reading three turns up
   * is the most common way a live log becomes unusable, and the assistant
   * appends a line every few seconds while a plan runs.
   */
  createEffect(
    on([() => props.history.length, () => props.partial], () => {
      const node = scroller
      if (!node) return
      const distanceFromBottom = node.scrollHeight - node.scrollTop - node.clientHeight
      if (distanceFromBottom < 120) node.scrollTop = node.scrollHeight
    }),
  )

  const submit = () => {
    const text = draft().trim()
    if (!text) return
    props.onSubmit(text)
    setDraft("")
    composer?.focus()
  }

  const onKeyDown = (event: KeyboardEvent) => {
    // Enter sends, Shift+Enter breaks the line: the convention every chat
    // surface on this machine already uses, including the agent CLIs below.
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault()
      submit()
    }
  }

  // Registered synchronously, which is the only way it runs: an `onCleanup`
  // after an `await` has a null owner and is silently dropped.
  onCleanup(() => {
    scroller = undefined
    composer = undefined
  })

  return (
    <section data-component="agent-console">
      <header data-slot="agent-head">
        <div data-slot="agent-identity">
          <span data-slot="agent-name">nik</span>
          <span data-slot="agent-presence" data-tone={presence().tone}>
            <i data-slot="agent-dot" />
            {presence().text}
          </span>
        </div>
        <div data-slot="agent-head-actions">
          <button
            type="button"
            data-slot="agent-action"
            data-primary={props.running ? undefined : "true"}
            onClick={() => props.onToggleMic()}
          >
            {props.running ? t("agent.mic.stop") : t("agent.mic.start")}
          </button>
          <button type="button" data-slot="agent-action" onClick={() => props.onOpenSettings()}>
            {t("agent.settings")}
          </button>
        </div>
      </header>

      {/* Said once, at the top, rather than as a failure on the first sentence
          the grammar cannot match: without a key the assistant still works,
          it just cannot plan. That is a setup fact, not an error. */}
      <Show when={!props.canPlan}>
        <p data-slot="agent-notice">
          {t("agent.noPlanner")}
        </p>
      </Show>

      <div data-slot="agent-scroll" ref={(el) => (scroller = el)}>
        <Show
          when={turns().length > 0 || props.partial}
          fallback={
            <div data-slot="agent-empty">
              <p data-slot="agent-empty-title">{t("agent.empty.title")}</p>
              <p data-slot="agent-empty-body">
                {t("agent.empty.body")}
              </p>
              <ul data-slot="agent-examples" lang="it">
                <li>«avvia quattro sessioni claude su questo progetto»</li>
                <li>«apri il pannello due»</li>
                <li>«cosa sta succedendo»</li>
              </ul>
            </div>
          }
        >
          <For each={turns()}>{(turn) => <Turn turn={turn} />}</For>

          {/* The sentence in flight, drawn like a prompt because that is what
              it is about to become. */}
          <Show when={props.partial}>
            <article data-slot="agent-turn">
              <div data-slot="agent-prompt" data-pending="true">
                {props.partial}
              </div>
            </article>
          </Show>
        </Show>
      </div>

      {/* Heard from the room while the assistant thought: not allowed to stop
          the turn, and not lost either. The button says «invia questa» for
          the user, so the engine has one path for voice and click. */}
      <Show when={props.held}>
        {(text) => (
          <div data-slot="agent-held" role="status">
            <span data-slot="agent-held-text">{t("agent.held", text())}</span>
            <button type="button" data-slot="agent-action" onClick={() => props.onSubmit("invia questa")}>
              {t("agent.sendHeld")}
            </button>
          </div>
        )}
      </Show>

      <div data-slot="agent-composer">
        <textarea
          ref={(el) => (composer = el)}
          data-slot="agent-input"
          rows="1"
          placeholder={t("agent.input")}
          value={draft()}
          onInput={(event) => setDraft(event.currentTarget.value)}
          onKeyDown={onKeyDown}
        />
        <button type="button" data-slot="agent-send" disabled={!draft().trim()} onClick={submit}>
          {t("agent.send")}
        </button>
      </div>
    </section>
  )
}

function Turn(props: { turn: AgentTurn }) {
  return (
    <article data-slot="agent-turn">
      <Show when={props.turn.prompt}>
        {(prompt) => (
          <div data-slot="agent-prompt">
            <span data-slot="agent-prompt-text">{prompt().text}</span>
            <time data-slot="agent-time">{timeOf(prompt().at)}</time>
          </div>
        )}
      </Show>
      <For each={props.turn.replies}>{(reply) => <Reply entry={reply} />}</For>
    </article>
  )
}

/*
 * Branching on `kind` without a `<Show>`, and that is correct here rather
 * than a shortcut: the log is append-only and every entry is frozen once
 * written, so an entry can never change kind under a rendered node. `For`
 * keys on identity and rebuilds the row if it is ever replaced.
 */
function Reply(props: { entry: Exclude<AgentEntry, { kind: "user" }> }) {
  const entry = props.entry
  if (entry.kind === "plan") {
    return (
      <div data-slot="agent-plan">
        <div data-slot="agent-plan-head">
          {t("agent.plan")}
          <span data-slot="agent-plan-count">
            {t("agent.plan.count", entry.ok, entry.ok + entry.failed)}
          </span>
        </div>
        <ol data-slot="agent-plan-steps">
          <For each={entry.steps}>
            {(step, index) => (
              <li data-slot="agent-plan-step" data-ok={index() < entry.ok ? "true" : "false"}>
                {step}
              </li>
            )}
          </For>
        </ol>
      </div>
    )
  }
  return <FlatReply entry={entry} />
}

function FlatReply(props: { entry: Exclude<AgentEntry, { kind: "user" } | { kind: "plan" }> }) {
  const text = () => (props.entry.kind === "action" ? props.entry.label : props.entry.text)
  const tone = () => {
    if (props.entry.kind === "error") return "error"
    if (props.entry.kind === "action") return props.entry.ok ? "done" : "error"
    return "say"
  }
  return (
    <div data-slot="agent-reply" data-kind={props.entry.kind} data-tone={tone()}>
      <span data-slot="agent-reply-text">{text()}</span>
      <Show when={props.entry.kind === "action" && props.entry.detail}>
        {(detail) => <span data-slot="agent-reply-detail">{detail()}</span>}
      </Show>
    </div>
  )
}
