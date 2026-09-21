import { describe, expect, it } from "bun:test"
import path from "path"

/**
 * The rules the TUI's components are held to, enforced rather than remembered.
 *
 * Every one of these is here because it was violated and the violation was
 * invisible: nothing failed, nothing looked wrong in review, and the cost
 * showed up as a component that quietly stopped reacting, a list that
 * remounted itself, or a click that did two things.
 *
 * Scanning source is the right tool for exactly these: each is a property of
 * the shape of the code, and the runtime failure needs a real terminal, a real
 * pointer or a live stream to reproduce.
 */

const ROOT = path.join(import.meta.dir, "../../../tui/src")

async function sources(): Promise<Array<{ file: string; text: string }>> {
  const glob = new Bun.Glob("**/*.{ts,tsx}")
  const out: Array<{ file: string; text: string }> = []
  for await (const file of glob.scan({ cwd: ROOT })) {
    out.push({ file, text: await Bun.file(path.join(ROOT, file)).text() })
  }
  return out
}

const ALL = await sources()

/**
 * Lists that rebuild but are not watched while they do.
 *
 * The rule is about a list updating under the reader's eyes — a chart moving, a
 * task reporting a tool call, a transcript streaming. The onboarding dialog is
 * ten rows, shown once at first run, and rebuilt when an arrow key moves the
 * cursor: the remount is real and imperceptible. Its `rows` list branches on a
 * discriminated union across fifty lines, and `Index` hands the callback an
 * accessor whose value must be read inside the JSX for the narrowing to hold —
 * so converting it is a restructure of the first thing a new user sees, for a
 * saving nothing can measure.
 *
 * Named rather than silently scoped out, so the cost of keeping it is visible.
 */
const ACCEPTED = new Set(["component/dialog-onboarding.tsx — options", "component/dialog-onboarding.tsx — rows"])

describe("TUI component rules", () => {
  it("scanned the tree, so an empty result means compliance and not a bad path", () => {
    expect(ALL.length).toBeGreaterThan(150)
  })

  it("no component destructures its props", () => {
    // Destructuring reads the prop once. `dialog-remote` did it to a connection
    // that a reconnect replaces, so the view went on writing to the dead one.
    const offenders = ALL.filter(({ text }) => /(?:function\s+[A-Z]\w*|const\s+[A-Z]\w*\s*=\s*)\(\s*\{/.test(text)).map(
      ({ file }) => file,
    )
    expect(offenders).toEqual([])
  })

  it("no component resolves its style through a memo", () => {
    // The JSX attribute does the tracking either way, so the memo only adds a
    // reactive node — once per mounted instance, in a transcript that mounts
    // thousands.
    const offenders = ALL.filter(({ text }) =>
      /const\s+\w*[Ss]tyle\w*\s*=\s*createMemo\(\(\)\s*=>\s*component\(/.test(text),
    ).map(({ file }) => file)
    expect(offenders).toEqual([])
  })

  it("no renderable is handed the catalog's own border array", () => {
    // One array per resolution is one array shared by every renderable reading
    // that entry, and `Box` keeps the reference it is given.
    const offenders = ALL.filter(({ text }) => /border=\{\w+\(\)\.box\.borderSides\}/.test(text)).map(
      ({ file }) => file,
    )
    expect(offenders).toEqual([])
  })

  it("no list rebuilt on every run is rendered with For", () => {
    // `For` reconciles by reference. Over a memo that maps to fresh objects it
    // tears the whole list down and rebuilds it on every update — a live chart
    // remounting sixty columns per frame, a task remounting its status rows per
    // tool call. Positional lists want `Index`.
    const offenders: string[] = []
    for (const { file, text } of ALL) {
      const builders = new Set<string>()
      for (const match of text.matchAll(/const\s+(\w+)\s*=\s*createMemo(?:<[^>]*>)?\(\(\)\s*=>\s*[^\n]*\.map\(/g)) {
        builders.add(match[1]!)
      }
      for (const match of text.matchAll(
        /const\s+(\w+)\s*=\s*createMemo(?:<[^>]*>)?\(\(\)\s*=>\s*\{([\s\S]*?)\n {2}\}\)/g,
      )) {
        if (/\.push\(\{|\.map\([^)]*=>\s*\(?\{/.test(match[2]!)) builders.add(match[1]!)
      }
      for (const name of builders) {
        if (new RegExp(`<For\\s+each=\\{${name}\\(\\)\\}`).test(text)) offenders.push(`${file} — ${name}`)
      }
    }
    expect(offenders.filter((entry) => !ACCEPTED.has(entry))).toEqual([])
  })

  it("the accepted list is still accurate, so it cannot outlive its reason", () => {
    // An exemption nobody rechecks becomes a lie. This fails once the code it
    // names changes shape, which is when somebody should look again.
    const onboarding = ALL.find(({ file }) => file === "component/dialog-onboarding.tsx")
    expect(onboarding).toBeDefined()
    expect(onboarding!.text).toContain("<For each={rows()}>")
  })
})
