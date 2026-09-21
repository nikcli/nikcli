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
/**
 * Flows where "back" is a step, not a screen.
 *
 * Sign-in walks username, then email, then password, and retries in place on
 * failure. A `←` there would have to mean the previous *step*, which is a
 * different feature with its own state to unwind — and pointing it at the root
 * would throw away what the person had already typed.
 */
const WIZARDS = ["component/dialog-login.tsx"]

const ACCEPTED = new Set(["component/dialog-onboarding.tsx — options", "component/dialog-onboarding.tsx — rows"])

/**
 * Every `onMouseUp={...}` in a file, with its body, by matching braces.
 *
 * A regex cannot find the end of a handler; a counter can, and these bodies are
 * small and well formed.
 */
function handlers(text: string): Array<{ line: number; body: string }> {
  const out: Array<{ line: number; body: string }> = []
  const marker = "onMouseUp={"
  let at = text.indexOf(marker)
  while (at !== -1) {
    let depth = 0
    let end = at + marker.length - 1
    for (; end < text.length; end++) {
      if (text[end] === "{") depth++
      else if (text[end] === "}") {
        depth--
        if (depth === 0) break
      }
    }
    out.push({ line: text.slice(0, at).split("\n").length, body: text.slice(at, end + 1) })
    at = text.indexOf(marker, end)
  }
  return out
}

/** A handler that only calls a named function is guarded if that function is. */
function guardedByCallee(text: string, body: string): boolean {
  for (const match of body.matchAll(/\b([a-z]\w*)\(/g)) {
    const name = match[1]!
    const declaration = new RegExp(`(?:function|const)\\s+${name}\\b`).exec(text)
    if (!declaration) continue
    const after = text.slice(declaration.index, declaration.index + 500)
    if (after.includes("getSelectedText()")) return true
  }
  return false
}

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

  it("no surface spells out in prose what the mark already says", () => {
    // Six surfaces each invented their own sentence — "Click to expand",
    // "Click to collapse", "follow logs", "view monitor output", "Click to view
    // this page in Web Preview", "Click to expand in TUI" — and every one cost
    // a row to say what `→` and `▸` say in a column. Two of them sat on the
    // same card.
    // Scoped to the transcript and its prompt, which is where the grammar
    // applies. A dialog's menu description and a placeholder teaching the `/`
    // key are different things: the first is a list convention, the second says
    // something no mark can, which is which key to press.
    const surfaces = ALL.filter(
      ({ file }) =>
        file.startsWith("routes/session/") || file.startsWith("component/prompt/") || /^component\/session-/.test(file),
    )
    expect(surfaces.length).toBeGreaterThan(10)

    const offenders: string[] = []
    for (const { file, text } of surfaces) {
      for (const match of text.matchAll(/["'`][^"'`\n]*\b(?:Click to|click to)\b[^"'`\n]*["'`]/g)) {
        offenders.push(`${file} — ${match[0]!.slice(0, 48)}`)
      }
    }
    expect(offenders).toEqual([])
  })

  it("every clickable transcript surface checks the selection before acting", () => {
    // A drag that ends on a row is somebody selecting text. Without the guard
    // the release is read as a click: the task card navigated out of the
    // session, the background bar opened a dialog, the retry message buried
    // itself under an alert. Found by hand three times, which is twice too
    // many.
    //
    // Per handler, not per file. The first version of this check passed a file
    // as soon as *one* handler guarded — which is a rule that stops working
    // precisely when a file grows a second handler, and every one of these
    // files has several.
    const offenders: string[] = []
    for (const { file, text } of ALL) {
      const transcript =
        file.startsWith("routes/session/") ||
        file.startsWith("component/prompt") ||
        /^component\/(session|pending)-/.test(file)
      if (!transcript) continue

      for (const handler of handlers(text)) {
        // Acting means leaving, or covering, what the reader was looking at.
        // A handler that only sets local state is not in scope: `setExpanded`
        // on a mark the reader aimed at is the click working as intended.
        if (!/navigate\(|dialog\.(replace|show)|DialogAlert\.show|open[A-Z]\w*\(|props\.onClick/.test(handler.body)) {
          continue
        }
        if (!handler.body.includes("getSelectedText()") && !guardedByCallee(text, handler.body)) {
          offenders.push(`${file}:${handler.line} — ${handler.body.slice(0, 44).replace(/\s+/g, " ")}`)
        }
      }
    }
    expect(offenders).toEqual([])
  })

  it("a dialog opened from a dialog offers the way back", () => {
    // Dialogs here do not stack — `replace` sets a one-entry stack and a nested
    // flow unmounts its parent, which `specs/effect-tui/03-tui-lifecycle.md`
    // records as load-bearing. So the way back is the caller handing over a
    // closure that reopens the parent, and the only thing stopping it from
    // being universal was that nothing asked.
    const offenders: string[] = []
    for (const { file, text } of ALL) {
      for (const match of text.matchAll(/DialogPrompt\.show\(dialog,[\s\S]{0,400}?\n {2,}\}\)/g)) {
        if (!match[0]!.includes("back")) {
          offenders.push(`${file} — ${match[0]!.slice(0, 56).replace(/\s+/g, " ")}`)
        }
      }
    }
    expect(offenders.filter((entry) => !WIZARDS.some((file) => entry.startsWith(file)))).toEqual([])
  })

  it("no dialog draws its own title row", () => {
    // Five did, each the same shape: a bold title, and a muted "esc" that was
    // text and nothing else. A header that *reads* "esc" takes the affordance
    // away from anyone driving with a mouse — which is what `DialogHeader`
    // exists to prevent, and says so in its own comment.
    const offenders = ALL.filter(({ text }) => />esc<\/text>/.test(text)).map(({ file }) => file)
    expect(offenders).toEqual([])
  })

  it("the accepted list is still accurate, so it cannot outlive its reason", () => {
    // An exemption nobody rechecks becomes a lie. This fails once the code it
    // names changes shape, which is when somebody should look again.
    const onboarding = ALL.find(({ file }) => file === "component/dialog-onboarding.tsx")
    expect(onboarding).toBeDefined()
    expect(onboarding!.text).toContain("<For each={rows()}>")
  })
})
