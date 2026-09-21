import { features } from "@nikcli-ai/util/features"
import { groupParts } from "../rows"
import { friendlyErrorMessage } from "../../../util/error-message"
import { TurnUsage } from "../../../util/turn-usage"
import { use } from "../session-context"
import { ExplorationSummary } from "../tool-view"
import { resolvePart } from "./registry"
import { TurnTokens } from "./turn-tokens"
import { UnknownPart } from "./unknown-part"
import { Locale } from "@nikcli-ai/util/locale"
import { Token } from "@nikcli-ai/util/token"
import { SplitBorder } from "@tui/component/border"
import { useLocal } from "@tui/context/local"
import { useSync } from "@tui/context/sync"
import { useTheme } from "@tui/context/theme"
import { For, Match, Show, Switch, createEffect, createMemo, createSignal, onCleanup } from "solid-js"
import { Dynamic } from "solid-js/web"
import type { ExplorationGroup } from "../rows"
import type { Turn, ViewEntry } from "../view"

export function AssistantMessage(props: { turn: Turn; last: boolean; usage?: TurnUsage.Turn }) {
  const ctx = use()
  const local = useLocal()
  const sync = useSync()
  const { theme } = useTheme()

  /**
   * Parts, with finished runs of read-only tool calls folded into one row.
   *
   * A live run stays fully expanded on purpose: collapsing it would hide work in
   * progress, and rebuilding the group row on every streamed delta would remount
   * its children. Only a run that is over — something followed it, or the message
   * finished — becomes a summary. With the flag off this is `props.parts`
   * unchanged, so the default render path keeps its stable part identities.
   */
  const rows = createMemo<(ViewEntry | ExplorationGroup<ViewEntry>)[]>(() => {
    if (!features(sync.data.config).tui.explorationGrouping) return props.turn.body
    const blocked = new Set(
      (sync.data.permission[props.turn.sessionID] ?? []).flatMap((request) =>
        request.tool?.callID ? [request.tool.callID] : [],
      ),
    )
    return (
      groupParts as unknown as (
        rows: readonly ViewEntry[],
        options: { closed: boolean; isPending: (entry: ViewEntry) => boolean },
      ) => ({ type: "part"; part: ViewEntry } | ExplorationGroup<ViewEntry>)[]
    )(props.turn.body, {
      closed: Boolean(props.turn.completedAt),
      isPending: (part) => "callID" in part && typeof part.callID === "string" && blocked.has(part.callID),
    }).flatMap<ViewEntry | ExplorationGroup<ViewEntry>>((row) =>
      row.type === "part" ? [row.part] : row.completed ? [row] : row.parts,
    )
  })

  const error = createMemo(() => props.turn.complete?.error as { name?: string } | undefined)

  const final = createMemo(() => {
    const finish = props.turn.complete?.finish
    return finish && !["tool-calls", "unknown"].includes(finish)
  })

  // Live duration ticks once a second. Reading `entry.text` here would
  // resubscribe this memo to every token and rewrite the footer 60 times a
  // second — the agent/model titles share that line and flash against the
  // wallpaper. Tok/s waits until the turn is sealed.
  const [now, setNow] = createSignal(Date.now())
  createEffect(() => {
    if (!props.last || props.turn.completedAt) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1000)
    onCleanup(() => clearInterval(timer))
  })

  const stats = createMemo(() => {
    // Counted from the prompt that caused the turn — which, in a turn list,
    // is simply the turn before this one.
    const created = props.turn.previousCreatedAt
    if (!created) return null

    const completedAt = props.turn.completedAt
    const end = completedAt ?? (props.last ? now() : created)
    const duration = Math.max(0, end - created)

    if (!completedAt) {
      return { duration, tps: 0 }
    }

    let text = ""
    let streamStart: number | undefined
    let streamEnd: number | undefined

    for (const entry of props.turn.body) {
      if (entry.type !== "text") continue
      text += String(entry.text ?? "")
      if (!entry.timestamp) continue
      streamStart = streamStart === undefined ? entry.timestamp : Math.min(streamStart, entry.timestamp)
      const finished = (entry.completed as number | undefined) ?? completedAt
      streamEnd = streamEnd === undefined ? finished : Math.max(streamEnd, finished)
    }

    if (streamStart === undefined || streamEnd === undefined) {
      return {
        duration,
        tps: 0,
      }
    }

    const streamDuration = Math.max(0, streamEnd - streamStart)
    const reported = props.turn.complete?.outputTokens ?? 0
    const outputTokens = reported > 0 ? reported : Token.estimate(text)

    return {
      duration,
      tps: streamDuration > 0 && outputTokens > 0 ? outputTokens / (streamDuration / 1000) : 0,
    }
  })

  return (
    <>
      <For each={rows()}>
        {(row) => {
          if (row.type === "group") return <ExplorationSummary group={row as never} sessionID={props.turn.sessionID} />
          const entry = row as ViewEntry
          return (
            // Through the registry, not the table, and resolved inside `when` so
            // the read is tracked: a `For` row body runs under `createRoot` and
            // does not subscribe to anything, so a value captured here would
            // pin the renderer for the life of the row. Read this way, a plugin
            // claiming (or releasing) the entry type swaps the renderer in
            // place without rebuilding the transcript.
            <Show when={resolvePart(row.type)} fallback={<UnknownPart entry={entry} />}>
              <Dynamic
                last={row === props.turn.body[props.turn.body.length - 1]}
                // `last` means "bottom of the turn" and stays true forever once
                // the turn is sealed. Whether the text is still *arriving* is a
                // different question, and it is the one the renderers need — the
                // same pair opencode reads (`part.time.completed`,
                // `message.time.completed`).
                streaming={entry.completed === undefined && props.turn.completedAt === undefined}
                // Resolved again rather than through `Show`'s callback form:
                // the callback wraps children in another memo, and this is a
                // per-part row in a transcript that mounts every row by
                // default. `Dynamic` tracks this read itself, so the plugin
                // swap still works.
                component={resolvePart(row.type)}
                entry={row as any}
                sessionID={props.turn.sessionID}
              />
            </Show>
          )
        }}
      </For>
      <Show when={error() && error()!.name !== "MessageAbortedError"}>
        <box
          border={["left"]}
          paddingTop={1}
          paddingBottom={1}
          paddingLeft={2}
          marginTop={1}
          backgroundColor={theme.surface.panel}
          customBorderChars={SplitBorder.customBorderChars}
          borderColor={theme.status.error.fg}
        >
          <text fg={theme.foreground.muted}>{friendlyErrorMessage(error())}</text>
        </box>
      </Show>
      <Switch>
        <Match when={props.last || final() || error()?.name === "MessageAbortedError"}>
          <box paddingLeft={3} marginTop={1} flexDirection="row" flexShrink={0}>
            <text>
              <span
                style={{
                  fg:
                    error()?.name === "MessageAbortedError"
                      ? theme.foreground.muted
                      : local.agent.color(props.turn.request?.agent ?? ""),
                }}
              >
                ▣{" "}
              </span>{" "}
              <span style={{ fg: theme.foreground.default }}>{Locale.titlecase(props.turn.request?.mode ?? "")}</span>
              <Show when={props.turn.request?.modelID}>
                <span style={{ fg: theme.foreground.muted }}> · {props.turn.request?.modelID}</span>
              </Show>
            </text>
            <Show when={stats()}>
              {(value) => (
                <text fg={theme.foreground.muted}>
                  {" · "}
                  {Locale.duration(value().duration)}
                  <Show when={value().tps > 0}> · {value().tps.toFixed(0)} tok/s</Show>
                </text>
              )}
            </Show>
            <Show when={error()?.name === "MessageAbortedError"}>
              <text fg={theme.foreground.muted}> · interrupted</text>
            </Show>
          </box>
        </Match>
      </Switch>
      <Show when={props.usage}>{(usage) => <TurnTokens turn={usage()} />}</Show>
    </>
  )
}
