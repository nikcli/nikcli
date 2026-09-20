import { describe, expect, test } from "bun:test"
import { createRoot } from "solid-js"
import { useAbortOnCleanup } from "@tui/util/lifecycle"
import { stripComments, tuiSource } from "./tui-source"

/**
 * The dialog stack contract, pinned because reading it wrong cost two reverts.
 *
 * `specs/effect-tui/03-tui-lifecycle.md` records both. The first round read
 * `replace()` setting the stack unconditionally and concluded that
 * `await …; dialog.replace(…)` reopens a dialog the user escaped. The second
 * replaced that with "guard the long-async awaits, leave the modal ones alone"
 * — right about which awaits matter, wrong about the mechanism, and it shipped:
 * picking a provider opened "Select auth method", and selecting an entry there
 * did nothing at all, because the guard it had gained was already disposed.
 *
 * One fact sits under both mistakes: **a nested dialog replaces its parent
 * rather than stacking on it**, so the component that opened it is unmounted as
 * part of the flow working, not because the user left.
 *
 * Asserted against the source, the trade `dialog-lifecycle.test.ts` documents
 * and seven tests in this directory already make. Mounting was tried:
 * `testRender` builds a renderer and `DialogProvider` needs only `ToastProvider`
 * above it, but rendering an *entry* pulls in `ThemeProvider`, which pulls in
 * `SyncProvider`, which bootstraps against a live server. The owner half below
 * needs no renderer at all and is exercised for real.
 */

const dialogSource = stripComments(await tuiSource("ui/dialog.tsx"))

describe("the stack is one deep (EOT-03)", () => {
  test("replace assigns a single-entry stack rather than pushing", () => {
    // `setStore("stack", [ { element, onClose } ])` — one entry, always. If
    // this became a push, "modal" would start meaning what people assume it
    // means, and the guards that were reverted would become correct.
    const replaceBody = dialogSource.slice(dialogSource.indexOf("replace(input: DialogElement"))
    expect(replaceBody).toMatch(/setStore\(\s*"stack",\s*\[/)
    expect(replaceBody).not.toMatch(/setStore\(\s*"stack",\s*\[\s*\.\.\.store\.stack/)
  })

  test("replace has no empty-stack guard, so an empty stack cannot mean the user left", () => {
    // Opening from nothing is a supported case — a command does it — which is
    // why "is the stack empty" is not a cancellation signal.
    const replaceBody = dialogSource.slice(
      dialogSource.indexOf("replace(input: DialogElement"),
      dialogSource.indexOf("get stack()"),
    )
    expect(replaceBody).not.toMatch(/if\s*\(\s*store\.stack\.length\s*===\s*0\s*\)\s*return/)
  })

  test("escape closes the top entry, which on a one-deep stack empties it", () => {
    expect(dialogSource).toMatch(/evt\.name === "escape"[\s\S]{0,120}closeTop\(\)/)
  })

  test("the nested helpers open through replace, so they unmount their caller", async () => {
    // This is the mechanism, stated where it can fail: if either helper ever
    // pushed instead, the caller would survive and an owner guard would work.
    for (const file of ["ui/dialog-prompt.tsx", "ui/dialog-confirm.tsx"]) {
      const source = stripComments(await tuiSource(file))
      const show = source.slice(source.indexOf(".show ="))
      expect(show).toContain("dialog.replace(")
    }
  })
})

describe("what that means for an owner guard", () => {
  test("a guard whose owner is torn down reports disposed, whatever tore it down", () => {
    // No renderer needed: disposal is disposal. The point is that in a chaining
    // dialog the teardown arrives from the nested `replace`, so
    // `if (alive.disposed()) return` after such an await always returns.
    let guard: ReturnType<typeof useAbortOnCleanup> | undefined
    let dispose!: () => void
    createRoot((d) => {
      dispose = d
      guard = useAbortOnCleanup()
    })
    expect(guard!.disposed()).toBe(false)
    dispose()
    expect(guard!.disposed()).toBe(true)
  })

  test("the leaf dialogs that use it correctly are still the ones that open nothing", async () => {
    // dialog-provider's AutoMethod, CodeMethod and AutoCodeMethod await a poll
    // and open no sub-dialog, which is the shape the helper is for. Pinned so a
    // future "consistency" pass does not spread it back to the chaining ones.
    const provider = stripComments(await tuiSource("component/dialog-provider.tsx"))
    expect(provider).toContain("useAbortOnCleanup")
    const chaining = stripComments(await tuiSource("component/dialog-auth-manage.tsx"))
    expect(chaining).not.toContain("useAbortOnCleanup")
  })
})
