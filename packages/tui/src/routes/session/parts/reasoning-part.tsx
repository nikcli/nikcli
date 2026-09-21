import { liveMarkdown, splitLiveMarkdown, wrapDiagramsInFences } from "../diagram"
import { use } from "../session-context"
import { Locale } from "@nikcli-ai/util/locale"
import { borderCharsFor } from "@tui/component/border"
import { Spinner } from "@tui/component/spinner"
import { useTheme } from "@tui/context/theme"
import { reasoningSummary } from "@tui/context/thinking"
import { MessageMarkdown } from "@tui/feature-plugins/math/markdown"
import { Match, Show, Switch, createMemo } from "solid-js"
import type { ViewEntry } from "../view"

export function ReasoningPart(props: { last: boolean; streaming: boolean; entry: ViewEntry; sessionID: string }) {
  const { theme, subtleSyntax, component } = useTheme()
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
    borderColor: theme.border.subtle,
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
  return (
    <Show when={content() && ctx.showThinking()}>
      <box
        id={"text-" + props.entry.id}
        paddingLeft={style().box.paddingLeft}
        marginTop={style().box.marginTop}
        flexDirection="column"
        border={style().box.borderSides}
        customBorderChars={borderCharsFor(style().box.borderCharset)}
        borderColor={style().colors.border}
      >
        <ReasoningHeader done={done()} title={summary().title} duration={duration()} />
        <Show when={summary().body}>
          <box marginTop={1} flexDirection="column">
            <Show when={split().settled}>
              <MessageMarkdown
                streaming={false}
                syntaxStyle={subtleSyntax()}
                content={split().settled}
                conceal={ctx.conceal()}
                concealCode={false}
                fg={theme.foreground.muted}
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
                  fg={theme.foreground.muted}
                  tableOptions={tableOptions()}
                />
              </box>
            </Show>
          </box>
        </Show>
      </box>
    </Show>
  )
}

export function ReasoningHeader(props: { done: boolean; title: string | null; duration?: string }) {
  const { theme, component } = useTheme()
  const style = () => component("session.reasoning-part")
  return (
    <Switch>
      <Match when={!props.done}>
        <box flexDirection="row">
          <Spinner color={theme.status.warning.fg}>{props.title ? "Thinking: " + props.title : "Thinking"}</Spinner>
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
