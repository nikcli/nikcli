/// <reference types="@types/bun" />

import { describe, expect, test } from "bun:test"
import { extractMessageArtifacts, extractSessionPreviews } from "./session-artifacts"
import type { MessageWithParts } from "./types"

function artifactMessage(input: {
  messageId: string
  artifactId: string
  kind: "image" | "video"
  version?: number
}): MessageWithParts {
  const url = `https://nikcli-ai.dev/artifact/${input.artifactId}`
  return {
    info: {
      id: input.messageId,
      sessionID: "ses_test",
      role: "assistant",
      time: { created: 1 },
    },
    parts: [
      {
        id: `part_${input.messageId}`,
        sessionID: "ses_test",
        messageID: input.messageId,
        type: "tool",
        callID: `call_${input.messageId}`,
        tool: "artifact",
        state: {
          status: "completed",
          input: {},
          output: `Published\n${url}`,
          title: `${input.kind} preview`,
          metadata: {
            id: input.artifactId,
            title: `${input.kind} preview`,
            url,
            viewerUrl: `${url}?key=view-key`,
            previewUrl: `${url}/raw?key=view-key`,
            kind: input.kind,
            version: input.version ?? 1,
            contentType: input.kind === "image" ? "image/png" : "video/mp4",
          },
          time: { start: 1, end: 2 },
        },
      },
    ],
  } as unknown as MessageWithParts
}

describe("published session artifacts", () => {
  test("extracts image and video capability previews from artifact tool metadata", () => {
    const image = artifactMessage({ messageId: "msg_image", artifactId: "img", kind: "image" })
    const video = artifactMessage({ messageId: "msg_video", artifactId: "vid", kind: "video" })

    const previews = extractSessionPreviews([image, video])

    expect(previews.map((item) => item.kind)).toEqual(["video", "image"])
    expect(previews[0]?.url).toBe("https://nikcli-ai.dev/artifact/vid?key=view-key")
    expect(previews[0]?.previewUrl).toBe("https://nikcli-ai.dev/artifact/vid/raw?key=view-key")
    expect(previews[0]?.viewerUrl).toBe("https://nikcli-ai.dev/artifact/vid?key=view-key")
  })

  test("keeps only the newest version of the same published artifact", () => {
    const older = artifactMessage({ messageId: "msg_old", artifactId: "same", kind: "image", version: 1 })
    const newer = artifactMessage({ messageId: "msg_new", artifactId: "same", kind: "image", version: 2 })

    const previews = extractSessionPreviews([older, newer])

    expect(previews).toHaveLength(1)
    expect(previews[0]?.artifact?.version).toBe(2)
  })

  test("surfaces a published artifact inline with its assistant message", () => {
    const message = artifactMessage({ messageId: "msg_inline", artifactId: "inline", kind: "image" })
    expect(extractMessageArtifacts(message)[0]?.artifact?.id).toBe("inline")
  })

  test("falls back to the persisted session collection after transcript compaction", () => {
    const previews = extractSessionPreviews([], undefined, [
      {
        id: "persisted",
        title: "Persisted video",
        filename: "demo.mp4",
        contentType: "video/mp4",
        kind: "video",
        url: "https://nikcli-ai.dev/artifact/persisted",
        viewerUrl: "https://nikcli-ai.dev/artifact/persisted?key=view-key",
        previewUrl: "https://nikcli-ai.dev/artifact/persisted/raw?key=view-key",
        version: 3,
        sessionID: "ses_test",
        size: 1_024,
        time: { created: 1, updated: 3 },
      },
    ])

    expect(previews).toHaveLength(1)
    expect(previews[0]?.artifact?.version).toBe(3)
    expect(previews[0]?.kind).toBe("video")
  })
})
