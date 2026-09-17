import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const src = join(import.meta.dir, "..")
const read = (name: string) => readFileSync(join(src, name), "utf8")

describe("record/badge", () => {
  // Dario, filming the promo: laid over the top-right corner, the badge covered
  // minimise, maximise and close.
  test("the REC badge sits in the bar, before the window controls", () => {
    const workbench = read("surface/workbench.tsx")
    const bar = workbench.slice(workbench.indexOf('data-slot="ade-bar"'), workbench.indexOf("</header>"))
    const badge = bar.indexOf('data-slot="ade-rec"')
    expect(badge).toBeGreaterThan(-1)
    expect(badge).toBeLessThan(bar.indexOf('data-slot="ade-window-controls"'))
    expect(workbench.split('data-slot="ade-rec"').length).toBe(2)
  })

  test("the badge is laid out in the bar, not pinned over its corner", () => {
    const css = read("index.css")
    const rule = css.slice(css.indexOf('[data-slot="ade-rec"] {'))
    const body = rule.slice(0, rule.indexOf("}"))
    expect(body).not.toContain("position: fixed")
    expect(body).not.toContain("right:")
    expect(body).toContain("z-index")
  })
})
