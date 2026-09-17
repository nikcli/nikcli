import { describe, expect, test } from "bun:test"
import { MODEL_EXTENSIONS } from "../model3d/model"
import { PLAYABLE_EXTENSIONS } from "../video/video"
import { paneShowing, routeForFile } from "./open-route"

describe("routeForFile", () => {
  test("every format the video panel plays opens a video panel, whatever the case or folder", () => {
    for (const extension of PLAYABLE_EXTENSIONS) {
      expect(`${extension}: ${routeForFile(`C:\\progetto\\video\\demo.${extension}`)}`).toBe(`${extension}: video`)
      expect(`${extension}: ${routeForFile(`/home/me/clip.${extension.toUpperCase()}`)}`).toBe(`${extension}: video`)
    }
    expect(routeForFile("registrazioni/ADE 2026-09-16.mp4")).toBe("video")
  })

  test("models still open the 3D panel", () => {
    for (const extension of MODEL_EXTENSIONS) expect(routeForFile(`assets/robot.${extension}`)).toBe("model")
  })

  test("everything else opens the editor, formats the panel cannot play included", () => {
    for (const path of ["src/index.ts", "README.md", "film.mkv", "film.avi", "mp4", "note.mp4.txt", "Makefile"]) {
      expect(`${path}: ${routeForFile(path)}`).toBe(`${path}: editor`)
    }
  })
})

describe("paneShowing", () => {
  const panes = [
    { id: "v1", mode: "video", videoPath: "C:\\Progetto\\video\\Demo.mp4" },
    { id: "v2", mode: "video", videoPath: "" },
    { id: "m1", mode: "model", modelPath: "C:/Progetto/assets/robot.glb" },
  ]

  test("finds the pane on the same file spelled with other case or separators", () => {
    expect(paneShowing(panes, "video", "c:/progetto/video/demo.mp4")?.id).toBe("v1")
    expect(paneShowing(panes, "model", "C:\\progetto\\assets\\ROBOT.glb")?.id).toBe("m1")
  })

  test("an empty pane, another file or the other panel is not a match", () => {
    expect(paneShowing(panes, "video", "")).toBeUndefined()
    expect(paneShowing(panes, "video", "C:/Progetto/video/altro.mp4")).toBeUndefined()
    expect(paneShowing(panes, "video", "C:/Progetto/assets/robot.glb")).toBeUndefined()
  })
})
