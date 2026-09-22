/// <reference types="@types/bun" />

import { describe, expect, test } from "bun:test"
import {
  ARTIFACT_MAX_BYTES,
  artifactShareUrl,
  canViewArtifact,
  parseArtifactPayload,
  parseByteRange,
  publicMeta,
  type StoredArtifact,
} from "./artifact"

const stored: StoredArtifact = {
  id: "artifact-id",
  title: "Preview",
  filename: "preview.png",
  contentType: "image/png",
  kind: "image",
  size: 3,
  version: 1,
  owner: "owner-id",
  secret: "update-secret",
  viewKey: "view-key",
  time: { created: 1, updated: 1 },
}

describe("artifact payloads", () => {
  test("accepts supported base64 media and derives its kind", () => {
    const parsed = parseArtifactPayload({
      title: "Preview",
      filename: "preview.png",
      contentType: "image/png",
      content: btoa("png"),
    })

    expect("error" in parsed).toBe(false)
    if (!("error" in parsed)) {
      expect(parsed.kind).toBe("image")
      expect(parsed.content.byteLength).toBe(3)
    }
  })

  test("rejects unsupported and oversized content", () => {
    expect(
      parseArtifactPayload({
        title: "Archive",
        filename: "archive.zip",
        contentType: "application/zip",
        content: btoa("zip"),
      }),
    ).toEqual({ error: "Unsupported contentType: application/zip" })

    const oversized = "A".repeat(Math.ceil((ARTIFACT_MAX_BYTES + 1) / 3) * 4)
    expect(
      parseArtifactPayload({ title: "Large", filename: "large.txt", contentType: "text/plain", content: oversized }),
    ).toEqual({ error: `Artifact exceeds ${ARTIFACT_MAX_BYTES} bytes` })
  })

  test("never exposes write or read capabilities in public metadata", () => {
    expect(publicMeta(stored)).not.toHaveProperty("secret")
    expect(publicMeta(stored)).not.toHaveProperty("viewKey")
    expect(canViewArtifact(stored, { userId: "owner-id", key: null })).toBe(true)
    expect(canViewArtifact(stored, { userId: null, key: "view-key" })).toBe(true)
    expect(canViewArtifact(stored, { userId: "another-user", key: null })).toBe(false)
  })

  test("share URL includes the view key (the bare page is login-gated)", () => {
    expect(artifactShareUrl("artifact-id", "view-key", "https://nikcli-ai.dev")).toBe(
      "https://nikcli-ai.dev/artifact/artifact-id?key=view-key",
    )
  })

  test("normalizes video byte ranges and rejects invalid ranges", () => {
    expect(parseByteRange("bytes=0-99", 1_000)).toEqual({ offset: 0, length: 100 })
    expect(parseByteRange("bytes=900-", 1_000)).toEqual({ offset: 900, length: 100 })
    expect(parseByteRange("bytes=-200", 1_000)).toEqual({ offset: 800, length: 200 })
    expect(parseByteRange("bytes=1000-", 1_000)).toBeNull()
    expect(parseByteRange("bytes=20-10", 1_000)).toBeNull()
  })
})
