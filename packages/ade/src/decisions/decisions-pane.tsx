import { For, Show, createEffect, createMemo, createSignal } from "solid-js"
import { formatDay, formatMoment } from "./answer"
import { DecisionCard } from "./decision-card"
import { recipientHint } from "./decisions-sheet"
import { recipientChange, recipientOptions, type RecipientStatus } from "./delivery"
import type { DecisionsHub } from "./hub"
import { bucketDecisions, describeProblems, type Decision } from "./state"
import "./decisions.css"
import { t } from "../i18n"

/**
 * The whole register in a grid pane: who receives the answers, what waits for
 * the user, what waits to be carried out, what was put off and what is done.
 *
 * The window is the quick way through the open ones; this is where an answer
 * is changed, a deferral brought back early, and a closed decision looked up.
 */
export function DecisionsPane(props: {
  hub: DecisionsHub
  focused: boolean
  onFocus?: () => void
  onClose?: () => void
  onExpand?: () => void
}) {
  const state = () => props.hub.register.state()
  const buckets = createMemo(() => bucketDecisions(state()?.decisions ?? []))
  const [expanded, setExpanded] = createSignal<string>()
  const [showClosed, setShowClosed] = createSignal(false)
  const now = () => props.hub.register.now()
  // The first open decision is answerable in place; another one once clicked.
  const active = () => expanded() && buckets().forYou.some((d) => d.k === expanded()) ? expanded() : buckets().forYou[0]?.k
  const problems = createMemo(() => {
    const loaded = props.hub.register.loaded()
    return loaded ? describeProblems(loaded.problems, state()?.rejected ?? []) : []
  })

  const card = (decision: Decision) => (
    <DecisionCard
      decision={decision}
      picked={props.hub.draft(decision.k).picked}
      note={props.hub.draft(decision.k).note}
      busy={props.hub.busy(decision.k)}
      problem={props.hub.problem(decision.k)}
      submitLabel={t("decisions.submit")}
      recipientHint={recipientHint(props.hub.recipient())}
      now={now()}
      onPick={(picked) => props.hub.setDraft(decision.k, { ...props.hub.draft(decision.k), picked })}
      onNote={(text) => props.hub.setDraft(decision.k, { ...props.hub.draft(decision.k), note: text })}
      onSubmit={() => void props.hub.answer(decision)}
      onDefer={(until) => void props.hub.defer(decision, until)}
    />
  )

  return (
    <article
      data-component="decisions-pane"
      data-focused={props.focused ? "true" : undefined}
      onFocusIn={() => props.onFocus?.()}
      onPointerDown={() => props.onFocus?.()}
    >
      <header data-slot="pane-header">
        <span data-slot="pane-identity" aria-hidden="true">
          <DecisionsGlyph />
        </span>
        <h2 data-slot="pane-title" title={props.hub.register.path()}>
          {t("decisions.title")}{buckets().forYou.length > 0 ? ` · ${t("decisions.openCount", buckets().forYou.length)}` : ""}
        </h2>
        <div data-slot="pane-actions">
          <button type="button" data-slot="pane-action" onClick={() => props.onExpand?.()} aria-label={t("pane.expand")}>
            <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">
              <path d="M1 4.5V1h3.5M11 7.5V11H7.5" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" />
            </svg>
          </button>
          <button type="button" data-slot="pane-action" onClick={() => props.onClose?.()} aria-label={t("pane.close")}>
            <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">
              <path d="M2.5 2.5l7 7M9.5 2.5l-7 7" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" />
            </svg>
          </button>
        </div>
      </header>

      <div data-slot="decisions-body">
        <Show when={!props.hub.register.path()}>
          <div data-slot="sheet-empty">
            <b>{t("decisions.noProject")}</b>
            <span>{t("decisions.noProject.hint")}</span>
          </div>
        </Show>
        <Show when={props.hub.register.error()}>
          <div data-slot="decision-problem" role="alert">{t("decisions.unreadable", String(props.hub.register.error()))}</div>
        </Show>
        <Show when={problems().length > 0}>
          <details data-slot="decisions-problems">
            <summary>{t("decisions.ignored", problems().length)}</summary>
            <ul>
              <For each={problems()}>{(line) => <li>{line}</li>}</For>
            </ul>
          </details>
        </Show>

        <Show when={props.hub.register.path()}>
          <RecipientPicker hub={props.hub} queued={buckets().answered.filter((decision) => props.hub.delivery(decision).state === "in coda").length} />
          <h4 data-slot="decisions-section">{t("decisions.section.open")}</h4>
          <Show when={buckets().forYou.length > 0} fallback={<p data-slot="decisions-none">{t("decisions.none")}</p>}>
            <div data-slot="decisions-list">
              <For each={buckets().forYou}>
                {(decision) => (
                  <Show
                    when={active() === decision.k}
                    fallback={
                      <button type="button" data-slot="decision-row" onClick={() => setExpanded(decision.k)}>
                        <span data-slot="decision-key">{decision.k}</span>
                        <span data-slot="decision-row-title">{decision.title}</span>
                        <span data-slot="decision-pill">{t("decisions.pill.open")}</span>
                      </button>
                    }
                  >
                    {card(decision)}
                  </Show>
                )}
              </For>
            </div>
          </Show>

          <Show when={buckets().answered.length > 0}>
            <h4 data-slot="decisions-section">{t("decisions.section.answered")}</h4>
            <div data-slot="decisions-list">
              <For each={buckets().answered}>
                {(decision) => (
                  <section data-slot="decision-card" data-state="risposta">
                    <header data-slot="decision-head">
                      <span data-slot="decision-key">{decision.k}</span>
                      <h3 data-slot="decision-title">{decision.title}</h3>
                      <span data-slot="decision-pill" data-tone="done">{t("decisions.pill.answered")}</span>
                    </header>
                    <div data-slot="decision-answer">
                      <b>{decision.answer?.choice ?? decision.answer?.words}</b>
                      <Show when={decision.answer?.choice && decision.answer?.note}> · {decision.answer?.note}</Show>
                    </div>
                    <Show when={props.hub.problem(decision.k)}>
                      <div data-slot="decision-problem" role="alert">{props.hub.problem(decision.k)}</div>
                    </Show>
                    <div data-slot="decision-actions">
                      <span data-slot="decision-hint">{deliveryText(props.hub, decision, now())}</span>
                      <button
                        type="button"
                        data-slot="decision-ghost"
                        disabled={props.hub.busy(decision.k)}
                        onClick={() => void props.hub.reopen(decision).then((done) => done && setExpanded(decision.k))}
                      >
                        {t("decisions.change")}
                      </button>
                    </div>
                  </section>
                )}
              </For>
            </div>
          </Show>

          <Show when={buckets().later.length > 0}>
            <h4 data-slot="decisions-section">{t("decisions.section.later")}</h4>
            <div data-slot="decisions-list">
              <For each={buckets().later}>
                {(decision) => (
                  <div data-slot="decision-row" data-static="true">
                    <span data-slot="decision-key">{decision.k}</span>
                    <span data-slot="decision-row-title">{decision.title}</span>
                    <span data-slot="decision-pill" data-tone="later">
                      {t("decisions.pill.deferred", formatDay(decision.deferredUntil ?? "", now()))}
                    </span>
                    <button
                      type="button"
                      data-slot="decision-ghost"
                      disabled={props.hub.busy(decision.k)}
                      onClick={() => void props.hub.reopen(decision).then((done) => done && setExpanded(decision.k))}
                    >
                      {t("decisions.reopen")}
                    </button>
                  </div>
                )}
              </For>
            </div>
          </Show>

          <Show when={buckets().closed.length > 0}>
            <button
              type="button"
              data-slot="decisions-section"
              data-toggle="true"
              aria-expanded={showClosed()}
              onClick={() => setShowClosed(!showClosed())}
            >
              {t("decisions.section.closed", buckets().closed.length)}
            </button>
            <Show when={showClosed()}>
              <div data-slot="decisions-list">
                <For each={[...buckets().closed].reverse()}>
                  {(decision) => (
                    <div data-slot="decision-row" data-static="true" title={decision.answer?.words}>
                      <span data-slot="decision-key">{decision.k}</span>
                      <span data-slot="decision-row-title">
                        {decision.title}
                        <Show when={decision.answer}> — {decision.answer?.choice ?? decision.answer?.words}</Show>
                      </span>
                      <span data-slot="decision-pill" data-tone="closed">
                        {decision.evidence ?? t("decisions.pill.closed", formatDay(decision.closedAt ?? "", now()))}
                      </span>
                    </div>
                  )}
                </For>
              </div>
            </Show>
          </Show>
        </Show>
      </div>
    </article>
  )
}

function deliveryText(hub: DecisionsHub, decision: Decision, now: Date): string {
  const delivery = hub.delivery(decision)
  if (delivery.state === "consegnata") return t("decisions.delivery.done", delivery.to, formatMoment(delivery.at, now))
  if (delivery.state === "in coda") return queuedText(hub.recipient())
  return t("decisions.delivery.by", decision.answer?.by ?? "?", formatDay(decision.answer?.at ?? "", now))
}

export function queuedText(recipient: RecipientStatus): string {
  if (recipient.state === "pronta") return t("decisions.queued.ready", recipient.title)
  if (recipient.state === "non attiva") return t("decisions.queued.idle", recipient.title)
  return t("decisions.queued.none")
}

/**
 * "Risposte a": any session, from any project, or nobody. With nobody, or with
 * a session that is not running, answers stay queued and the warning says so.
 */
function RecipientPicker(props: { hub: DecisionsHub; queued: number }) {
  const status = () => props.hub.recipient()
  const chosenId = () => (status().state === "non scelta" ? "" : (status() as { id: string }).id)
  // A session picked while answers are queued, waiting for "Consegna".
  const [pending, setPending] = createSignal<string>()
  const pendingTitle = () => props.hub.sessions().find((pane) => pane.id === pending())?.title ?? pending()
  const select = (value: string) => {
    const next = value || undefined
    const change = recipientChange(chosenId() || undefined, next, props.queued)
    if (change === "conferma") setPending(next)
    else {
      setPending(undefined)
      if (change === "applica") props.hub.choose(next)
    }
  }
  const options = createMemo(() => recipientOptions(props.hub.sessions(), status(), pending()))
  let selectEl: HTMLSelectElement | undefined
  // After the options are rebuilt, put the select back on the entry it must show.
  createEffect(() => {
    const shown = options().find((option) => option.selected)?.value ?? ""
    if (selectEl && selectEl.value !== shown) selectEl.value = shown
  })
  return (
    <div data-slot="decisions-recipient" data-state={status().state}>
      <label>
        <span>{t("decisions.recipient")}</span>
        <select ref={selectEl} onChange={(event) => select(event.currentTarget.value)}>
          <For each={options()}>
            {(option) => (
              <option value={option.value} selected={option.selected}>
                {option.label}
              </option>
            )}
          </For>
        </select>
      </label>
      <Show when={pending()}>
        <div data-slot="decisions-recipient-confirm" role="alert">
          <span>
            {t("decisions.recipient.confirm", props.queued, String(pendingTitle() ?? ""))}
          </span>
          <button
            type="button"
            data-slot="decision-submit"
            onClick={() => {
              const next = pending()
              props.hub.choose(next)
              setPending(undefined)
            }}
          >
            {t("decisions.recipient.deliver")}
          </button>
          <button type="button" data-slot="decision-ghost" onClick={() => setPending(undefined)}>
            {t("new.cancel")}
          </button>
        </div>
      </Show>
      <Show when={!pending() && status().state !== "pronta"}>
        <p data-slot="decisions-recipient-warning" role="status">
          {status().state === "non scelta"
            ? t("decisions.recipient.none")
            : t("decisions.recipient.idle", (status() as { title: string }).title)}
          {props.queued > 0 ? ` ${t("decisions.recipient.waiting", props.queued)}` : ""}
        </p>
      </Show>
    </div>
  )
}

export function DecisionsGlyph() {
  return (
    <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.2" aria-hidden="true">
      <path d="M8 1.8v3.4M8 5.2L3.2 9.4M8 5.2l4.8 4.2" stroke-linecap="round" stroke-linejoin="round" />
      <circle cx="3.2" cy="11.6" r="2.2" />
      <circle cx="12.8" cy="11.6" r="2.2" />
    </svg>
  )
}
