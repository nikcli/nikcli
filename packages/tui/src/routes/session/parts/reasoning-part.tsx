import { liveMarkdown, splitLiveMarkdown, wrapDiagramsInFences } from "../diagram"
import { use } from "../session-context"
import { Locale } from "@nikcli-ai/util/locale"
import { borderCharsFor } from "@tui/component/border"
import { DISCLOSURE, hiddenRows, LESS, more, worthCollapsing } from "@tui/component/disclosure"
import { bodyColumns } from "@tui/context/component-tokens"
import { Spinner } from "@tui/component/spinner"
import { useTheme } from "@tui/context/theme"
import { reasoningSummary } from "@tui/context/thinking"
import { MessageMarkdown } from "@tui/feature-plugins/math/markdown"
import { Match, Show, Switch, createMemo, createSignal } from "solid-js"
import type { ViewEntry } from "../view"

export function ReasoningPart(props: { last: boolean; streaming: boolean; entry: ViewEntry; sessionID: string }) {
  const { subtleSyntax, component } = useTheme()
  const style = () => component("session.reasoning-part")
  const ctx = use()
  const content = createMemo(() => {
    // Filter out redacted reasoning chunks from OpenRouter
    // OpenRouter sends encrypted reasoning data that appears as [REDACTED]
    const raw = String(props.entry.text ?? "")
      .replace("[REDACTED]", "")
      // OpenAI Responses reasoning summaries separate sections with empty
      // HTML comments (`<!-- -->`); they are markers, not content.
      .replace(/<!--\s*-->/g, "")
    return liveMarkdown(raw, props.streaming)
  })
  const summary = createMemo(() => reasoningSummary(content()))
  const body = createMemo(() => {
    const text = summary().body
    if (!text) return ""
    return props.streaming ? text : wrapDiagramsInFences(text)
  })
  const split = createMemo(() => (props.streaming ? splitLiveMarkdown(body()) : { settled: body(), live: "" }))
  const tight = createMemo(() => ctx.width < 84)
  const tableOptions = createMemo(() => ({
    widthMode: "full" as const,
    wrapMode: "word" as const,
    cellPadding: tight() ? 0 : 1,
    borders: true,
    outerBorder: !tight(),
    borderColor: style().colors.tableBorder,
  }))
  const done = createMemo(() => {
    const end = props.entry.completed as number | undefined
    return end !== undefined
  })
  const duration = createMemo(() => {
    const end = props.entry.completed as number | undefined
    if (end === undefined) return
    return Locale.duration(end - props.entry.timestamp)
  })

  /**
   * The last surface in the transcript that could run to forty rows uncollapsed.
   *
   * Two conditions, and both matter. It must be *finished*: while the model is
   * thinking, watching it think is the entire reason `showThinking` is on, and
   * folding that away would answer a question nobody asked. And it must be
   * *tall*, by the same six-row measure as a message — a short thought read in
   * passing costs less than the click to open it.
   *
   * `showThinking` keeps meaning what it says. On, a thought is shown; this only
   * decides whether a finished one that nobody will read in full has to occupy
   * the screen as though they would.
   */
  const [expanded, setExpanded] = createSignal(false)
  const columns = createMemo(() => bodyColumns(style().box, ctx.width))
  const collapsible = createMemo(() => done() && worthCollapsing(summary().body ?? "", columns()))
  const collapsed = createMemo(() => collapsible() && !expanded())
  const hidden = createMemo(() => hiddenRows(summary().body ?? "", columns()))
  return (
    <Show when={content() && ctx.showThinking()}>
      <box
        id={"text-" + props.entry.id}
        paddingLeft={style().box.paddingLeft}
        marginTop={style().box.marginTop}
        flexDirection="column"
        border={[...style().box.borderSides]}
        customBorderChars={borderCharsFor(style().box.borderCharset)}
        borderColor={style().colors.border}
      >
        <ReasoningHeader done={done()} title={summary().title} duration={duration()} />
        <Show when={collapsed()}>
          {/* The header above is already the summary, so the fold costs the
              reader nothing but the count of what it holds. */}
          <text
            fg={style().colors.body}
            wrapMode="none"
            onMouseUp={(event) => {
              event.stopPropagation()
              setExpanded(true)
            }}
          >
            {DISCLOSURE.closed} {more(hidden(), "rows")}
          </text>
        </Show>
        <Show when={summary().body && !collapsed()}>
          <box marginTop={1} flexDirection="column">
            <Show when={split().settled}>
              <MessageMarkdown
                streaming={false}
                syntaxStyle={subtleSyntax()}
                content={split().settled}
                conceal={ctx.conceal()}
                concealCode={false}
                fg={style().colors.body}
                tableOptions={tableOptions()}
              />
            </Show>
            <Show when={split().live}>
              <box marginTop={split().settled ? 1 : 0} flexShrink={0}>
                <MessageMarkdown
                  streaming={props.streaming}
                  syntaxStyle={subtleSyntax()}
                  content={split().live}
                  conceal={ctx.conceal()}
                  concealCode={false}
                  fg={style().colors.body}
                  tableOptions={tableOptions()}
                />
              </box>
            </Show>
          </box>
          <Show when={collapsible()}>
            <text
              fg={style().colors.body}
              wrapMode="none"
              onMouseUp={(event) => {
                event.stopPropagation()
                setExpanded(false)
              }}
            >
              {DISCLOSURE.open} {LESS}
            </text>
          </Show>
        </Show>
      </box>
    </Show>
  )
}

export function ReasoningHeader(props: { done: boolean; title: string | null; duration?: string }) {
  const { component } = useTheme()
  const style = () => component("session.reasoning-part")
  return (
    <Switch>
      <Match when={!props.done}>
        <box flexDirection="row">
          <Spinner color={style().colors.heading}>{props.title ? "Thinking: " + props.title : "Thinking"}</Spinner>
        </box>
      </Match>
      <Match when={props.done}>
        <text fg={style().colors.heading} wrapMode="none">
          <span>Thought</span>
          <Show when={props.title || props.duration}>
            <span>: </span>
          </Show>
          <Show when={props.title}>
            <span>{props.title}</span>
          </Show>
          <Show when={props.duration}>
            <span>
              {props.title ? " · " : ""}
              {props.duration}
            </span>
          </Show>
        </text>
      </Match>
    </Switch>
  )
}
