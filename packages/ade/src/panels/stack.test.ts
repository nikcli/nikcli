import { describe, expect, test } from "bun:test"
import { isPanelPane } from "../surface/state"
import { filesToStamp, isSuperseded, sameFiles, SUPERSEDED } from "../model3d/model"
import { createPanelRouter, type PanelHandler } from "./router"
import { createPanelStack } from "./stack"

const handler = (detail: string): PanelHandler => ({
  verbs: [],
  run: async () => ({ ok: true, detail }),
})

const ask = async (router: ReturnType<typeof createPanelRouter>) => {
  const handled = await router.handle("@ade model state")
  return handled && "reply" in handled ? handled.reply : ""
}

describe("panes of one kind behind one name", () => {
  test("closing the older pane leaves the newer one answering", async () => {
    const router = createPanelRouter()
    const stack = createPanelStack(router, "model")
    stack.push("a", handler("A"))
    stack.push("b", handler("B"))
    stack.remove("a")
    expect(await ask(router)).toContain("B")
  })

  test("closing the answering pane hands the name back to the one left, then to nobody", async () => {
    const router = createPanelRouter()
    const stack = createPanelStack(router, "model")
    stack.push("a", handler("A"))
    stack.push("b", handler("B"))
    stack.remove("b")
    expect(await ask(router)).toContain("A")
    stack.remove("a")
    expect(router.open()).toEqual([])
  })

  test("the router removes a handler only if it is still the registered one", () => {
    const router = createPanelRouter()
    const first = handler("1")
    router.register("video", first)
    router.register("video", handler("2"))
    router.unregister("video", first)
    expect(router.open()).toEqual(["video"])
    router.unregister("video")
    expect(router.open()).toEqual([])
  })
})

describe("3D reloads", () => {
  test("a reload of the same file stamps every file it read; a new file only itself", () => {
    expect(filesToStamp("/p/a.gltf", "/p/a.gltf", ["/p/a.gltf", "/p/a.bin"])).toEqual(["/p/a.gltf", "/p/a.bin"])
    expect(filesToStamp("/p/b.glb", "/p/a.gltf", ["/p/a.gltf", "/p/a.bin"])).toEqual(["/p/b.glb"])
    expect(sameFiles(["x", "y"], ["y", "x"])).toBe(true)
    expect(sameFiles(["x"], ["x", "y"])).toBe(false)
  })

  test("an overtaken load is recognised and not shown as an error", () => {
    expect(isSuperseded(new Error(SUPERSEDED))).toBe(true)
    expect(isSuperseded(new Error("file troppo grande"))).toBe(false)
  })
})

describe("panels are not sessions", () => {
  test("an empty player, viewer or simulator is a panel by its mode", () => {
    const base = { mode: "bot" }
    expect(isPanelPane(base)).toBe(false)
    for (const mode of ["video", "model", "app"]) expect(isPanelPane({ mode })).toBe(true)
    expect(isPanelPane({ mode: "video", videoPath: "" })).toBe(true)
    expect(isPanelPane({ mode: "bot", browserUrl: "https://x" })).toBe(true)
    expect(isPanelPane({ mode: "bot", plugin: "p" } as never)).toBe(true)
  })
})
