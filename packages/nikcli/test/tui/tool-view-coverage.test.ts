import { describe, expect, it } from "bun:test"
import path from "path"

/**
 * Every tool that produces something the transcript can draw has a view that
 * draws it.
 *
 * `multiedit` published a `filePath` and a unified `diff`, exactly as `edit`
 * does, and had no case in the dispatch at all — so every multi-edit fell
 * through to the generic one-row view and its diff was never drawn. Nothing
 * failed. The tool worked, the metadata arrived, and the renderer that could
 * have shown it was one `Match` away.
 *
 * A one-row generic view is a fine default and most tools want nothing more.
 * The failure is narrower than "a tool without a view": it is a tool that hands
 * the transcript a payload the transcript has a renderer for, and is routed
 * somewhere that ignores it.
 */

const TOOLS = path.join(import.meta.dir, "../../src/tool")
const VIEW = path.join(import.meta.dir, "../../../tui/src/routes/session/tool-view.tsx")

const view = await Bun.file(VIEW).text()

/** Tool ids the TUI dispatches to a dedicated view. */
const routed = new Set([...view.matchAll(/toolName\(\) === "([a-z_0-9]+)"/g)].map((match) => match[1]!))

async function toolsPublishing(key: string): Promise<string[]> {
  const glob = new Bun.Glob("*.ts")
  const found: string[] = []
  for await (const file of glob.scan({ cwd: TOOLS })) {
    const text = await Bun.file(path.join(TOOLS, file)).text()
    const id = /Tool\.define\("([a-z_0-9]+)"/.exec(text)?.[1]
    if (!id) continue
    if (new RegExp(`^\\s+${key}[,:]`, "m").test(text)) found.push(id)
  }
  return found.sort()
}

describe("tool view coverage", () => {
  it("reads the dispatch, so an empty routed set cannot pass this file", () => {
    expect(routed.size).toBeGreaterThan(15)
    expect(routed.has("edit")).toBe(true)
  })

  it("every tool that publishes a diff is routed to a view that renders one", async () => {
    const publishers = await toolsPublishing("diff")
    // The tools are real, so a change that stops them publishing diffs should
    // be noticed here rather than quietly emptying this check.
    expect(publishers).toContain("multiedit")
    expect(publishers.length).toBeGreaterThanOrEqual(3)

    const missing = publishers.filter((id) => !routed.has(id))
    expect(missing).toEqual([])
  })

  it("the views those tools reach actually draw a diff", () => {
    // Routing is half the fix; the destination has to be the diff renderer.
    expect(view).toContain('toolName() === "edit" || toolName() === "multiedit"')
    expect(view).toContain("<diff")
  })
})
