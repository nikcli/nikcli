import { describe, expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

/*
 * Every kind of pane can be expanded and closed, and the two buttons show.
 *
 * Read from the sources rather than rendered: the panes need a host, a
 * workbench and a WebGL or video element each, and what broke in 0.6.1 was a
 * stylesheet, which happy-dom does not cascade. The video and editor panes had
 * the buttons, wired, but invisible: `pane-actions` starts at opacity 0 and
 * only some panes had the rule that reveals it.
 */

const src = join(import.meta.dir, "..")
const read = (path: string) => readFileSync(join(src, path), "utf8")
const renderer = read("surface/pane-renderer.tsx")

/** The file a component imported by the renderer lives in, through a barrel if there is one. */
function componentFile(component: string): string {
  const from = new RegExp(`import \\{[^}]*\\b${component}\\b[^}]*\\} from "\\.\\./([^"]+)"`).exec(renderer)?.[1]
  if (!from) throw new Error(`${component} is not imported by the renderer`)
  if (existsSync(join(src, `${from}.tsx`))) return `${from}.tsx`
  const barrel = read(`${from}/index.ts`)
  const named = new RegExp(`export \\{[^}]*\\b${component}\\b[^}]*\\} from "\\./([^"]+)"`).exec(barrel)?.[1]
  const star = [...barrel.matchAll(/export \* from "\.\/([^"]+)"/g)]
    .map((match) => match[1]!)
    .find(
      (file) =>
        existsSync(join(src, from, `${file}.tsx`)) &&
        read(`${from}/${file}.tsx`).includes(`export function ${component}(`),
    )
  const inner = named ?? star
  if (!inner) throw new Error(`${component} is not exported by ${from}/index.ts`)
  return `${from}/${inner}.tsx`
}

/** Each `const xPane = () => (<Component …/>)` of the renderer, with its props. */
const panes = [...renderer.matchAll(/const (\w+Pane) = \(\) => \(\s*<(\w+)([\s\S]*?)\n    \)\n/g)].map((match) => ({
  name: match[1]!,
  component: match[2]!,
  props: match[3]!,
}))

describe("pane chrome", () => {
  test("the renderer's panes are all found", () => {
    expect(panes.map((pane) => pane.name).sort()).toEqual(
      [
        "browserPane",
        "decisionsPane",
        "filePane",
        "modelPane",
        "pluginPane",
        "sessionPane",
        "simulatorPane",
        "videoPane",
      ].sort(),
    )
  })

  for (const pane of panes) {
    test(`${pane.name} is given expand and close, and has buttons for both`, () => {
      expect(pane.props).toMatch(/\bonClose=\{/)
      expect(pane.props).toMatch(/\bonExpand=\{/)
      const source = read(componentFile(pane.component))
      // Its own buttons, or the shared ones given both handlers.
      const shared =
        /<PaneActions onExpand=\{\(\) => props\.onExpand\?\.\(\)\} onClose=\{\(\) => props\.onClose\?\.\(\)\}/.test(
          source,
        )
      if (!shared) {
        expect(source).toMatch(/onClick=\{\(\) => props\.onExpand\?\.\(\)\}/)
        expect(source).toMatch(/onClick=\{\(\) => props\.onClose\?\.\(\)\}/)
      }
    })
  }

  test("the video pane has the session's header and buttons (0.6.1)", () => {
    for (const file of ["grid/pane.tsx", "video/video-pane.tsx"]) {
      const source = read(file)
      expect(`${file}: ${source.includes('<header class="pill hA" data-slot="pane-header">')}`).toBe(`${file}: true`)
      expect(`${file}: ${source.includes("<PaneActions onExpand=")}`).toBe(`${file}: true`)
    }
    const actions = read("grid/pane-actions.tsx")
    expect(actions).toContain('class="act" data-slot="pane-action"')
    expect(actions).toContain('data-slot="pane-actions"')
  })

  test("every pane that uses the shared actions is revealed by the shared rule", () => {
    const css = read("grid/pane.css")
    expect(css).toContain('[data-component$="-pane"]:hover [data-slot="pane-actions"]')
    expect(css).toContain('[data-component$="-pane"][data-focused] [data-slot="pane-actions"]')
    for (const pane of panes) {
      const file = componentFile(pane.component)
      const source = read(file)
      if (!source.includes('data-slot="pane-actions"')) continue
      const component = /data-component="([^"]+)"/.exec(source)?.[1]
      expect(`${file}: ${component}`).toMatch(/: [\w-]+-pane$/)
    }
  })

  test("a pane that is a size container grows into its cell", () => {
    // A size container stops taking its width from its content: without
    // `flex: 1` the video pane was 1.6px wide in ADE Test.
    const collapsed: string[] = []
    for (const entry of new Bun.Glob("**/*.css").scanSync(src)) {
      const file = entry.replace(/\\/g, "/")
      const css = readFileSync(join(src, file), "utf8").replace(/\/\*[\s\S]*?\*\//g, "")
      for (const rule of css.split("}")) {
        const selector = rule.slice(0, rule.indexOf("{")).trim().split("\n").pop() ?? ""
        if (!/^\[data-component="[\w-]+-pane"\]$/.test(selector)) continue
        if (/container-type:\s*(inline-)?size/.test(rule) && !/\bflex:\s*1\b/.test(rule))
          collapsed.push(`${file}: ${selector}`)
      }
    }
    expect(collapsed).toEqual([])
  })

  test("no stylesheet hides the shared actions again", () => {
    const hidden: string[] = []
    for (const entry of new Bun.Glob("**/*.css").scanSync(src)) {
      const file = entry.replace(/\\/g, "/")
      if (file === "grid/pane.css") continue
      for (const rule of readFileSync(join(src, file), "utf8").split("}")) {
        if (rule.includes('[data-slot="pane-actions"]') && /opacity:\s*0\b/.test(rule)) {
          hidden.push(`${file}: ${rule.trim().split("\n")[0]}`)
        }
      }
    }
    expect(hidden).toEqual([])
  })
})
