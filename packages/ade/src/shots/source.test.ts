import { describe, expect, test } from "bun:test"
import { createRoot } from "solid-js"
import { createShotSource } from "./source"

/**
 * The browser path only — no host to watch a folder — which is exactly the
 * behaviour worth pinning: the tray must be empty and inert rather than broken
 * when there is nothing to watch.
 */
describe("createShotSource without a host", () => {
  test("starts empty and claims no folder", () => {
    createRoot((dispose) => {
      const source = createShotSource(false)
      expect(source.shots()).toEqual([])
      expect(source.folder()).toBeUndefined()
      dispose()
    })
  })

  test("loading an image resolves to nothing rather than throwing", async () => {
    await createRoot(async (dispose) => {
      const source = createShotSource(false)
      expect(await source.load("C:/Pictures/Screenshots/a.png")).toBeNull()
      dispose()
    })
  })

  test("dismissing something that is not there is harmless", () => {
    createRoot((dispose) => {
      const source = createShotSource(false)
      source.dismiss("C:/Pictures/Screenshots/mai-esistito.png")
      expect(source.shots()).toEqual([])
      dispose()
    })
  })

  test("removing without a host still empties the tray", async () => {
    await createRoot(async (dispose) => {
      const source = createShotSource(false)
      await source.remove("C:/Pictures/Screenshots/a.png")
      expect(source.shots()).toEqual([])
      dispose()
    })
  })
})
