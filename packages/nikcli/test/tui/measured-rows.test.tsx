import { describe, expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { createSignal, For } from "solid-js"

/**
 * Guards the measurement the windowed session list depends on.
 *
 * `routes/session/index.tsx` learns each row's real height from `Renderable.onSizeChange`
 * (fired from `onResize` after layout). If that callback did not fire on first layout or when
 * content grows, measured heights would silently stay on the estimate and the window would drift.
 */
describe("measured rows", () => {
  test("onSizeChange reports the laid-out height on first layout", async () => {
    const measured = new Map<string, number>()
    const { renderOnce } = await testRender(
      () => (
        <scrollbox height={10} width={30}>
          <box ref={(el) => (el.onSizeChange = () => measured.set("row", el.height))}>
            <text>line 1</text>
            <text>line 2</text>
            <text>line 3</text>
          </box>
        </scrollbox>
      ),
      { width: 30, height: 10 },
    )
    await renderOnce()
    await renderOnce()
    expect(measured.get("row")).toBe(3)
  })

  test("onSizeChange follows content that grows", async () => {
    const measured: number[] = []
    const [lines, setLines] = createSignal(2)
    const { renderOnce } = await testRender(
      () => (
        <scrollbox height={10} width={30}>
          <box ref={(el) => (el.onSizeChange = () => measured.push(el.height))}>
            <For each={Array.from({ length: lines() }, (_, i) => i)}>{(i) => <text>line {i}</text>}</For>
          </box>
        </scrollbox>
      ),
      { width: 30, height: 10 },
    )
    await renderOnce()
    await renderOnce()
    expect(measured.at(-1)).toBe(2)

    setLines(5)
    await renderOnce()
    await renderOnce()
    expect(measured.at(-1)).toBe(5)
  })
})
