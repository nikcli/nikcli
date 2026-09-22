import { describe, expect, test } from "bun:test"
import ts from "typescript"
import { createGlobalEmitter } from "@solid-primitives/event-bus"
import { createRoot, onCleanup, onMount } from "solid-js"
import { useAbortOnCleanup } from "@tui/util/lifecycle"
import { stripComments, TUI_SRC, tuiSource } from "./tui-source"

/**
 * The unmount-during-await race, from both ends.
 *
 * `useAbortOnCleanup` is the primitive: it is exercised for real below. The
 * dialogs that use it are not mounted here — `DialogAccountLogin` alone wants
 * SDK, sync, theme, kv, toast and dialog providers, and `SyncProvider`
 * bootstraps against a live server — so their side is asserted against the
 * source, the same trade `onboarding-auth.test.ts` documents.
 *
 * What the source assertions actually protect: a guard placed after the *first*
 * await only. Aborting is not synchronous with a continuation, so every step
 * after every await has to re-check, and the failure mode of a missing check is
 * silent — a dialog stack that grows one screen after the user left it.
 */
describe("useAbortOnCleanup", () => {
  test("is live until its owner is disposed", () => {
    createRoot((dispose) => {
      const life = useAbortOnCleanup()
      expect(life.disposed()).toBe(false)
      expect(life.signal.aborted).toBe(false)

      dispose()

      expect(life.disposed()).toBe(true)
      expect(life.signal.aborted).toBe(true)
    })
  })

  test("aborts the request it was passed to", () => {
    let aborts = 0
    createRoot((dispose) => {
      const life = useAbortOnCleanup()
      // What an in-flight `fetch` sees: the signal it was handed fires on unmount.
      life.signal.addEventListener("abort", () => {
        aborts++
      })
      expect(aborts).toBe(0)
      dispose()
    })
    expect(aborts).toBe(1)
  })

  test("a resolution that lands after dispose is still catchable", async () => {
    let acted = false
    await new Promise<void>((resolve) => {
      createRoot((dispose) => {
        const life = useAbortOnCleanup()
        // The request already resolved; the continuation runs after unmount.
        void Promise.resolve("token").then(() => {
          if (life.disposed()) return resolve()
          acted = true
          resolve()
        })
        dispose()
      })
    })
    expect(acted).toBe(false)
  })
})

describe("dialogs that await", () => {
  test("the provider OAuth callback is abortable and re-guarded after every await", async () => {
    const src = stripComments(await tuiSource("component/dialog-provider.tsx"))
    expect(src).toContain("useAbortOnCleanup")
    // The long poll gets the signal, so `esc` ends the request itself.
    expect(src).toMatch(/oauth\.callback\([\s\S]{0,400}?\{ signal: life\.signal \}/)
    // Nothing that mutates the app — instance disposal, the stack — runs
    // unguarded inside the three method components. (`useDisconnectProvider`
    // awaits the same calls from a command handler, which has no unmount to
    // race, so the assertion starts at the first component.)
    const methods = src.slice(src.indexOf("function AutoMethod"))
    for (const line of [
      "await sdk.client.instance.dispose()\n",
      "await sync.bootstrap()\n",
      "await sync.refreshProviders()\n",
    ]) {
      const occurrences = methods.split(line).length - 1
      expect(occurrences).toBeGreaterThan(0)
      const guarded = methods
        .split(line)
        .slice(1)
        .filter((rest) => rest.trimStart().startsWith("if (life.disposed()) return"))
      expect(guarded.length).toBe(occurrences)
    }
  })

  test("account sign-in re-guards after save and rejects a null local user", async () => {
    const src = stripComments(await tuiSource("component/dialog-account-login.tsx"))
    // `stale()` is the stronger form of the old `disposed` flag: it is true
    // once the dialog is gone *and* once `r` has started a newer attempt, so
    // an older run cannot write its session over the newer one's.
    const afterSave = src.split("await UserSession.save(session.data.accessToken)")[1]
    expect(afterSave.trimStart().startsWith("if (stale()) return")).toBe(true)
    const afterMe = src.split("await UserApi.me(sdk)")[1]
    expect(afterMe.trimStart().startsWith("if (stale()) return")).toBe(true)
    // Every await in the flow is guarded, and the guard belongs to an attempt.
    expect(src).toMatch(/const \{ signal, stale \} = attempts\.start\(\)/)
    expect(src).not.toMatch(/if \(disposed\) return/)
    // The start request carries the attempt's signal, so a superseded attempt
    // stops talking to the issuer instead of running to its own timeout.
    expect(src).toMatch(/UserApi\.accountLogin\(sdk, signal\)/)
    // A good issuer token with no local user is a failed sign-in, not a success toast.
    expect(src).toMatch(/if \(!localUser\) throw new Error\(/)
    expect(src.indexOf("if (!localUser) throw")).toBeLessThan(src.indexOf("toast.show({"))
  })

  test("live web preview has a page keyboard under the surface that types into the WebView", async () => {
    const src = stripComments(await tuiSource("component/dialog-web-preview.tsx"))
    expect(src).toContain('type FocusArea = "url" | "content" | "page"')
    expect(src).toContain("function focusPageBar(")
    expect(src).toContain("function submitPageText(")
    expect(src).toContain('placeholder="type into the page')
    expect(src).toContain("sendToPage({ text: v })")
    expect(src).toContain('sendToPage({ key: "enter" })')
    expect(src).toContain('evt.ctrl && evt.name === "k" && live()')
    const contentBox = src.indexOf("height={contentHeight()}")
    const pageBar = src.indexOf('placeholder="type into the page')
    expect(contentBox).toBeGreaterThan(-1)
    expect(pageBar).toBeGreaterThan(contentBox)
  })

  test("a browser surface whose start raced with unmount is still removed", async () => {
    const src = stripComments(await tuiSource("component/browser-surface.tsx"))
    // `started` is only true after the round trip; the cleanup keys on the request.
    expect(src).toContain("if (startRequested && socketPath) {")
    expect(src).not.toContain("if (started && socketPath) {")
    const beforeStart = src.split('await call!("start"')[0]
    expect(beforeStart).toContain("startRequested = true")
  })

  test("a failed shell or slash submit keeps what the user typed", async () => {
    const src = stripComments(await tuiSource("component/prompt/index.tsx"))
    expect(src).toContain("function restoreSubmission(")
    // Restoring is skipped once the composer holds anything again.
    expect(src).toMatch(/function restoreSubmission[\s\S]{0,200}?if \(input\.plainText\.length > 0\) return/)
    // Both fire-and-forget paths inspect the envelope instead of dropping it.
    const shell = src.split("sdk.client.session\n        .shell(")[1] ?? src.split(".shell(")[1]
    expect(shell).toContain('reportSubmitFailure(error, inputText, "shell")')
    expect(src).toContain('reportSubmitFailure(error, inputText, "normal")')
  })

  test("the dialog focus restore is cancellable and loses to a newer dialog", async () => {
    const src = stripComments(await tuiSource("ui/dialog.tsx"))
    expect(src).toContain("function cancelRefocus()")
    // Both timers are tracked — the 30ms reclaim was the untracked one.
    expect(src).toContain("if (reclaimTimer) clearTimeout(reclaimTimer)")
    // `replace` invalidates whatever the dialog it replaces had queued.
    const replaceBody = src.split("replace(input: DialogElement")[1]?.split("batch(")[0] ?? ""
    expect(replaceBody).toContain("cancelRefocus()")
    // A restore only lands on an empty stack.
    expect(src).toMatch(/generation !== refocusGeneration \|\| store\.stack\.length > 0/)
  })

  test("session tab shortcuts do not fire underneath a dialog", async () => {
    const src = stripComments(await tuiSource("component/session-tabs.tsx"))
    const handler = src.split("useKeyboard((event) => {")[1] ?? ""
    expect(handler.trimStart().startsWith("if (dialog.stack.length > 0) return")).toBe(true)
  })
})

/**
 * Work registered after an `await` has no owner.
 *
 * Solid's owner is a synchronous context: inside `onMount(async () => …)` it is
 * current until the first `await`, and gone after it. `onCleanup` called past
 * that point is dropped, and so is the automatic unsubscribe `sdk.event.on`
 * attaches through `tryOnCleanup` — so a dialog that subscribes after loading
 * something keeps every listener, and the closure over its unmounted state,
 * for the life of the process. `DialogSupport` did exactly that, three
 * listeners per open.
 */
describe("owner-bound work after an await", () => {
  function mountAfterAwait(register: (on: () => () => void) => void) {
    // The emitter `sdk.event` is built on, so the auto-unsubscribe under test is the real one.
    const bus = createGlobalEmitter<{ tick: number }>()
    let hits = 0
    let dispose!: () => void
    let subscribed!: () => void
    const ready = new Promise<void>((resolve) => (subscribed = resolve))
    createRoot((d) => {
      dispose = d
      register(() => bus.on("tick", () => hits++))
    })
    return {
      ready,
      subscribed: () => subscribed(),
      async unmountAndEmit() {
        await ready
        dispose()
        bus.emit("tick", 1)
        return hits
      },
    }
  }

  test("an onCleanup registered after the await never runs", async () => {
    const probe = mountAfterAwait((on) =>
      onMount(async () => {
        await Promise.resolve()
        const off = on()
        onCleanup(off)
        probe.subscribed()
      }),
    )
    expect(await probe.unmountAndEmit()).toBe(1)
  })

  test("a release registered before the await does run", async () => {
    const probe = mountAfterAwait((on) => {
      const subscriptions: Array<() => void> = []
      onCleanup(() => {
        for (const off of subscriptions.splice(0)) off()
      })
      onMount(async () => {
        await Promise.resolve()
        subscriptions.push(on())
        probe.subscribed()
      })
    })
    expect(await probe.unmountAndEmit()).toBe(0)
  })

  test("the support dialog releases its live-event listeners and re-guards every await", async () => {
    const src = stripComments(await tuiSource("component/dialog-support.tsx"))
    const mount = src.indexOf("onMount(async () => {")
    const release = src.indexOf("for (const off of subscriptions.splice(0)) off()")
    expect(release).toBeGreaterThan(-1)
    // Registered while the owner is still current, i.e. before the async mount.
    expect(release).toBeLessThan(mount)
    expect(src).toContain("subscriptions.push(offPart, offIdle, offError)")
    const body = src.slice(mount)
    expect(body.split("await support.ensure()")[1]?.trimStart().startsWith("if (life.disposed()) return")).toBe(true)
    expect(body).toMatch(
      /\.messages\(\{ sessionID \}, \{ signal: life\.signal \}\)\.catch\(\(\) => null\)\s*if \(life\.disposed\(\)\) return/,
    )
  })

  test("no TUI source calls an owner-bound primitive after an await", async () => {
    // Every one of these either needs the current owner or registers against it.
    const OWNER_BOUND = new Set([
      "onCleanup",
      "onMount",
      "createEffect",
      "createRenderEffect",
      "createComputed",
      "createMemo",
      "createResource",
      "useKeyboard",
      "useTerminalDimensions",
    ])
    const isFunction = (node: ts.Node): node is ts.FunctionLikeDeclaration =>
      ts.isArrowFunction(node) ||
      ts.isFunctionExpression(node) ||
      ts.isFunctionDeclaration(node) ||
      ts.isMethodDeclaration(node)
    const offenders: string[] = []
    let scanned = 0
    for await (const file of new Bun.Glob("**/*.{ts,tsx}").scan(TUI_SRC)) {
      scanned++
      const text = await Bun.file(TUI_SRC + file).text()
      const kind = file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS
      const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind)
      const visit = (fn: ts.FunctionLikeDeclaration) => {
        if (!fn.body || !fn.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword)) return
        // Nested functions are their own scope: they are visited on their own.
        const within = (node: ts.Node, each: (node: ts.Node) => void) => {
          each(node)
          ts.forEachChild(node, (child) => {
            if (!isFunction(child)) within(child, each)
          })
        }
        let firstAwait = Infinity
        within(fn.body, (node) => {
          if (ts.isAwaitExpression(node) || (ts.isForOfStatement(node) && node.awaitModifier))
            firstAwait = Math.min(firstAwait, node.getStart())
        })
        within(fn.body, (node) => {
          if (!ts.isCallExpression(node) || node.getStart() < firstAwait) return
          if (!ts.isIdentifier(node.expression) || !OWNER_BOUND.has(node.expression.text)) return
          const line = sf.getLineAndCharacterOfPosition(node.getStart()).line + 1
          offenders.push(`${file}:${line} ${node.expression.text}`)
        })
      }
      const walk = (node: ts.Node) => {
        if (isFunction(node)) visit(node)
        ts.forEachChild(node, walk)
      }
      walk(sf)
    }
    // A scan of the wrong directory would pass vacuously.
    expect(scanned).toBeGreaterThan(100)
    expect(offenders).toEqual([])
  })
})

/**
 * Process-wide listeners a provider installs belong to the provider.
 *
 * Production mounts each provider once per process, which hid this; a test file
 * or an embedding host mounts them repeatedly, and every mount left a listener
 * — and the store it closes over — on `process` for good.
 */
describe("provider process listeners", () => {
  test("the KV provider removes its exit flush when it is disposed", async () => {
    const { KVProvider } = await import("@tui/context/kv")
    const before = process.listenerCount("exit")
    const dispose = createRoot((dispose) => {
      KVProvider({ children: undefined })
      return dispose
    })
    expect(process.listenerCount("exit")).toBe(before + 1)
    dispose()
    expect(process.listenerCount("exit")).toBe(before)
  })

  test("the theme provider removes its SIGUSR2 reload when it is disposed", async () => {
    const src = stripComments(await tuiSource("context/theme.tsx"))
    expect(src).toContain('process.on("SIGUSR2", onReloadSignal)')
    expect(src).toContain('onCleanup(() => process.off("SIGUSR2", onReloadSignal))')
  })
})
