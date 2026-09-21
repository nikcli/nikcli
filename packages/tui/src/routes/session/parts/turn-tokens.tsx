import { TurnUsage } from "../../../util/turn-usage"
import { useTheme } from "@tui/context/theme"
import { For, Show, createMemo } from "solid-js"

/**
 * Per-turn token table. Off by default (`tui.turn_tokens`); the parent only
 * builds the data when it is on, so this renders nothing on the default path.
 */
export function TurnTokens(props: { turn: TurnUsage.Turn }) {
  const { component } = useTheme()
  const style = () => component("session.turn-tokens")
  const num = (value: number) => value.toLocaleString()
  const widths = createMemo(() => {
    const steps = props.turn.steps
    return {
      step: Math.max("Step".length, ...steps.map((s) => s.finish.length)),
      newTokens: Math.max("New".length, ...steps.map((s) => num(s.newTokens).length), num(props.turn.newTokens).length),
      cached: Math.max("Cached".length, ...steps.map((s) => num(s.cached).length), num(props.turn.cached).length),
      total: Math.max("Total".length, ...steps.map((s) => num(s.total).length), num(props.turn.total).length),
    }
  })
  const row = (step: string, a: string, b: string, c: string) =>
    `${step.padEnd(widths().step + 2)}${a.padStart(widths().newTokens)}  ${b.padStart(widths().cached)}  ${c.padStart(widths().total)}`

  return (
    <box paddingLeft={style().box.paddingLeft} flexDirection="column">
      <text fg={style().colors.text}>{row("Step", "New", "Cached", "Total")}</text>
      <For each={props.turn.steps}>
        {(step) => (
          <text fg={style().colors.text}>
            {row(step.finish, num(step.newTokens), num(step.cached), num(step.total))}
            <Show when={step.cacheBust !== undefined}>
              <span style={{ fg: style().colors.warning }}> ⚠ cache bust −{num(step.cacheBust!)}</span>
            </Show>
          </text>
        )}
      </For>
      <Show when={props.turn.steps.length > 1}>
        <text fg={style().colors.text}>
          {row("turn", num(props.turn.newTokens), num(props.turn.cached), num(props.turn.total))}
        </text>
      </Show>
    </box>
  )
}
