/// <reference types="@types/bun" />

import { describe, expect, test } from "bun:test"
import { collectSessionPreviews, sessionPreviewFrameUrl } from "./session-preview"

describe("desktop session previews", () => {
  test("uses capability URLs for image and video artifacts", () => {
    const parts = ["image", "video"].map((kind, index) => ({
      id: `part_${index}`,
      type: "tool",
      tool: "artifact",
      state: {
        status: "completed",
        title: `${kind} preview`,
        metadata: {
          id: kind,
          title: `${kind} preview`,
          kind,
          url: `https://nikcli-ai.dev/artifact/${kind}`,
          viewerUrl: `https://nikcli-ai.dev/artifact/${kind}?key=view-key`,
          previewUrl: `https://nikcli-ai.dev/artifact/${kind}/raw?key=view-key`,
          version: 1,
        },
      },
    }))

    const previews = collectSessionPreviews(parts)
    expect(previews.map((item) => item.kind)).toEqual(["image", "video"])
    expect(previews[1]?.url).toBe("https://nikcli-ai.dev/artifact/video?key=view-key")
    expect(previews[1]?.previewUrl).toBe("https://nikcli-ai.dev/artifact/video/raw?key=view-key")
  })

  test("collects direct and tool image/video attachments", () => {
    const previews = collectSessionPreviews([
      { id: "image", type: "file", mime: "image/png", filename: "chart.png", url: "data:image/png;base64,aA==" },
      {
        id: "tool",
        type: "tool",
        tool: "render",
        state: {
          status: "completed",
          attachments: [
            { id: "video", type: "file", mime: "video/mp4", filename: "demo.mp4", url: "https://cdn/demo.mp4" },
          ],
        },
      },
    ])

    expect(previews.map((item) => item.title)).toEqual(["chart.png", "demo.mp4"])
    expect(previews.map((item) => item.kind)).toEqual(["image", "video"])
  })

  test("keeps the latest version of an artifact", () => {
    const artifact = (version: number) => ({
      type: "tool",
      tool: "artifact",
      state: {
        status: "completed",
        metadata: {
          id: "same",
          title: "Dashboard",
          kind: "html",
          version,
          url: "https://nikcli-ai.dev/artifact/same",
          viewerUrl: `https://nikcli-ai.dev/artifact/same?version=${version}`,
        },
      },
    })

    const previews = collectSessionPreviews([artifact(1), artifact(2)])
    expect(previews).toHaveLength(1)
    expect(previews[0]?.version).toBe(2)
    expect(previews[0]?.previewUrl).toContain("version=2")
  })

  test("reloads the embedded viewer when an artifact version changes", () => {
    const [preview] = collectSessionPreviews([
      {
        type: "tool",
        tool: "artifact",
        state: {
          status: "completed",
          metadata: {
            id: "same",
            title: "Dashboard",
            kind: "html",
            version: 2,
            url: "https://nikcli-ai.dev/artifact/same",
            viewerUrl: "https://nikcli-ai.dev/artifact/same?key=view-key",
          },
        },
      },
    ])

    expect(preview).toBeDefined()
    expect(sessionPreviewFrameUrl(preview!)).toBe("https://nikcli-ai.dev/artifact/same?key=view-key&_nikcli_preview=2")
  })
})
