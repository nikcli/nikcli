import { afterEach, describe, expect, it } from "bun:test"
import path from "path"
import { Artifact } from "@/artifact"
import { ArtifactTool } from "@/tool/artifact"
import { withIsolatedDatabase } from "../helpers/sqlite"
import { makeToolContext, withProjectDirectory } from "../helpers/tool-context"

const ORIGINAL_FETCH = globalThis.fetch
const ORIGINAL_ARTIFACT_URL = process.env["NIKCLI_ARTIFACT_URL"]

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH
  if (ORIGINAL_ARTIFACT_URL === undefined) delete process.env["NIKCLI_ARTIFACT_URL"]
  else process.env["NIKCLI_ARTIFACT_URL"] = ORIGINAL_ARTIFACT_URL
})

describe("Artifact share URLs", () => {
  it("appends the view key to the canonical page", () => {
    expect(
      Artifact.viewerUrl({
        url: "https://nikcli-ai.dev/artifact/a14e5eb6-3095-4501-8853-2a821a4f01eb",
        viewKey: "view-key",
      }),
    ).toBe("https://nikcli-ai.dev/artifact/a14e5eb6-3095-4501-8853-2a821a4f01eb?key=view-key")
  })

  it("leaves the url unchanged when viewKey is missing", () => {
    expect(
      Artifact.viewerUrl({
        url: "https://nikcli-ai.dev/artifact/a14e5eb6-3095-4501-8853-2a821a4f01eb",
        viewKey: "",
      }),
    ).toBe("https://nikcli-ai.dev/artifact/a14e5eb6-3095-4501-8853-2a821a4f01eb")
  })

  it("is idempotent when the url already carries ?key=", () => {
    expect(
      Artifact.viewerUrl({
        url: "https://nikcli-ai.dev/artifact/a14e5eb6-3095-4501-8853-2a821a4f01eb?key=view-key",
        viewKey: "view-key",
      }),
    ).toBe("https://nikcli-ai.dev/artifact/a14e5eb6-3095-4501-8853-2a821a4f01eb?key=view-key")
  })

  it("puts the capability key on the raw preview URL", () => {
    expect(
      Artifact.previewUrl({
        id: "a14e5eb6-3095-4501-8853-2a821a4f01eb",
        viewKey: "view-key",
      }),
    ).toBe("https://nikcli-ai.dev/artifact/a14e5eb6-3095-4501-8853-2a821a4f01eb/raw?key=view-key")
  })
})

describe("ArtifactTool", () => {
  it("returns a ?key= capability link as metadata.url, not the login-gated page", async () => {
    await withIsolatedDatabase(async ({ home }) => {
      const { Database } = await import("@/database/database")
      Database.syncDb()

      process.env["NIKCLI_ARTIFACT_URL"] = "https://nikcli-ai.dev"
      // SAFETY: the stub answers the single publish call this test makes, so it
      // implements only the slice of `fetch` that call exercises.
      globalThis.fetch = (async (input: string | URL | Request) => {
        expect(String(input)).toBe("https://nikcli-ai.dev/api/artifact")
        return Response.json(
          {
            id: "a14e5eb6-3095-4501-8853-2a821a4f01eb",
            url: "https://nikcli-ai.dev/artifact/a14e5eb6-3095-4501-8853-2a821a4f01eb",
            secret: "update-secret",
            viewKey: "view-key",
            version: 3,
          },
          { status: 201 },
        )
      }) as typeof fetch

      const filePath = path.join(home, "report.html")
      await Bun.write(filePath, "<html><body>ok</body></html>")

      const def = await ArtifactTool.init()
      const { ctx } = makeToolContext()
      const result = await withProjectDirectory(home, () =>
        def.executeAsync({ filePath, title: "State of AI CLI Agents (2026)" }, ctx),
      )

      const bare = "https://nikcli-ai.dev/artifact/a14e5eb6-3095-4501-8853-2a821a4f01eb"
      const keyed = `${bare}?key=view-key`
      expect(result.output).toContain(keyed)
      expect(result.metadata).toMatchObject({
        url: keyed,
        viewerUrl: keyed,
        viewKey: "view-key",
        previewUrl: `${bare}/raw?key=view-key`,
      })
      expect(String(result.metadata.url)).toContain("?key=")

      const listed = await Artifact.list(ctx.sessionID)
      expect(listed).toHaveLength(1)
      expect(listed[0]?.url).toBe(keyed)
    })
  })
})
