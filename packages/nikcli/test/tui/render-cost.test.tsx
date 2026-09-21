import { afterAll, describe, expect, test } from "bun:test"
import { Renderable } from "@opentui/core"
import { testRender } from "@opentui/solid"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { preserveTestEnv } from "../helpers/env"

const testHome = await fs.mkdtemp(path.join(os.tmpdir(), "nikcli-render-cost-"))
process.env.NIKCLI_TEST_HOME = testHome
process.env.NIKCLI_DB = path.join(testHome, "data", "nikcli.db")
process.env.NIKCLI_DISABLE_PROJECT_CONFIG = "1"
preserveTestEnv(["NIKCLI_TEST_HOME", "NIKCLI_DB", "NIKCLI_DISABLE_PROJECT_CONFIG"])

const [{ Harness }, { UserMessage }, { loadBuiltInTheme }, { createStandaloneTheme }] = await Promise.all([
  import("@nikcli-ai/tui-storybook/harness.tsx"),
  import("@tui/routes/session/parts"),
  import("@tui/context/theme-catalog"),
  import("@tui/context/theme"),
])

const document = await loadBuiltInTheme("nikcli")
const theme = createStandaloneTheme({ document, mode: "dark" })
const style = theme.component("session.user-message")

/**
 * What a transcript costs the renderer, measured against a real one.
 *
 * The session's components are rendered here through the storybook's own
 * harness — the same contexts a story gets — so this measures the components
 * that ship rather than a model of them. Two things are worth knowing and only
 * one of them was obvious.
 */
function countRenderables() {
  const add = (Renderable.prototype as unknown as Record<string, any>).add
  let mounted = 0
  ;(Renderable.prototype as unknown as Record<string, any>).add = function (this: unknown, ...args: unknown[]) {
    mounted++
    return add.apply(this, args as never)
  }
  return {
    stop() {
      ;(Renderable.prototype as unknown as Record<string, any>).add = add
      return mounted
    },
  }
}

const PARA = "Il renderer piega il messaggio in blocchi e dipinge ognuno nel buffer. "
function body(chars: number) {
  let out = ""
  while (out.length < chars) out += PARA
  return out.slice(0, chars)
}

function turnOf(text: string) {
  return {
    messageID: "m1",
    sessionID: "storybook",
    role: "user" as const,
    createdAt: 1,
    compacted: false,
    body: [{ id: "e1", messageID: "m1", sessionID: "storybook", type: "user", timestamp: 1, text }],
  }
}

async function mount(text: string) {
  const counter = countRenderables()
  const { renderOnce } = await testRender(
    () => (
      <Harness document={document} mode="dark" width={110} height={40}>
        <box width={110}>
          <UserMessage turn={turnOf(text) as never} index={0} pending={undefined} onMouseUp={() => {}} style={style} />
        </box>
      </Harness>
    ),
    { width: 110, height: 40 },
  )
  renderOnce()
  return counter.stop()
}

afterAll(async () => {
  await fs.rm(testHome, { recursive: true, force: true }).catch(() => {})
})

describe("what a message costs the renderer", () => {
  test("a body's length does not buy renderables, which is not where the saving is", async () => {
    // Measured, and it corrected a claim made from the armchair: a `<text>`
    // holding nine thousand characters is the same number of renderables as one
    // holding ninety. Wrapping eighty rows is work the renderer does *inside*
    // one renderable, so collapsing a body does not remove renderables — it
    // removes rows, which is scroll extent, buffer and wrapping, not nodes.
    const counter = countRenderables()
    const { renderOnce } = await testRender(
      () => (
        <box width={110}>
          <text>{body(9000)}</text>
        </box>
      ),
      { width: 110, height: 40 },
    )
    renderOnce()
    const long = counter.stop()

    const second = countRenderables()
    const { renderOnce: renderShort } = await testRender(
      () => (
        <box width={110}>
          <text>{body(90)}</text>
        </box>
      ),
      { width: 110, height: 40 },
    )
    renderShort()
    expect(long).toBe(second.stop())
  })

  test("a collapsed message costs the same whatever it holds", async () => {
    const short = await mount(body(90))
    const paste = await mount(body(2600))
    const wake = await mount(body(9000))

    // One extra for the disclosure mark, and then flat: the point of the rule
    // is that a nine-thousand-character wake message is not more expensive to
    // have in the transcript than the prompt above it.
    expect(paste).toBe(wake)
    expect(wake).toBeLessThanOrEqual(short + 1)
  })
})
