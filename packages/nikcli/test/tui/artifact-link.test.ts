import { describe, expect, it } from "bun:test"
import { artifactPublishedHref } from "@tui/util/tool-shapes"
import { source, stripComments, tuiSource } from "./tui-source"

const bare = "https://nikcli-ai.dev/artifact/a14e5eb6-3095-4501-8853-2a821a4f01eb"
const keyed = `${bare}?key=view-key`

describe("artifact published link", () => {
  it("prefers the ?key= capability URL over the login-gated page", () => {
    expect(artifactPublishedHref({ url: bare, viewerUrl: keyed })).toBe(keyed)
  })

  it("falls back to the canonical URL when no capability link exists", () => {
    expect(artifactPublishedHref({ url: bare })).toBe(bare)
  })

  it("reconstructs ?key= from viewKey when the stored url is login-gated", () => {
    expect(artifactPublishedHref({ url: bare, viewKey: "view-key" })).toBe(keyed)
  })

  it("recovers the capability link from tool output (screenshot card had only metadata.url)", () => {
    expect(
      artifactPublishedHref(
        { url: bare, title: "State of AI CLI Agents (2026)" },
        `Published "State of AI CLI Agents (2026)" (html, v3)\n${keyed}\nTo update this artifact later, call the artifact tool with artifactID: a14e5eb6-3095-4501-8853-2a821a4f01eb`,
      ),
    ).toBe(keyed)
  })

  it("renders the published card from artifactPublishedHref with metadata and output", async () => {
    const view = stripComments(await tuiSource("routes/session/tool-view.tsx"))
    expect(view).toContain("artifactPublishedHref(props.metadata, props.output)")
    expect(view).not.toMatch(/const url = createMemo\(\(\) => props\.metadata\.url\)/)
  })

  it("artifact tool source puts the capability URL on metadata.url", async () => {
    const tool = stripComments(await source("tool/artifact.ts"))
    expect(tool).toContain("url: shareUrl")
    expect(tool).toContain("viewKey: info.viewKey")
    expect(tool).not.toMatch(/url:\s*info\.url/)
  })

  it("Link emits an OSC-8 <a href> so Cmd-click keeps ?key=", async () => {
    const link = stripComments(await tuiSource("ui/link.tsx"))
    expect(link).toContain("<a href={props.href}>")
    expect(link).toContain('wrapMode="char"')
  })
})
