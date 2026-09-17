import { describe, expect, test } from "bun:test"
import { isReleasePage, newerRelease, parseVersion, type GithubRelease } from "./release"

const release = (tag: string, extra: Partial<GithubRelease> = {}): GithubRelease => ({
  tag_name: tag,
  html_url: `https://github.com/SandroHub013/nikcli/releases/tag/${tag}`,
  draft: false,
  prerelease: false,
  ...extra,
})

describe("parseVersion", () => {
  test("reads the tag, the bare version and a v-prefixed one", () => {
    expect(parseVersion("ade-v1.2.3")).toEqual([1, 2, 3])
    expect(parseVersion("1.2.3")).toEqual([1, 2, 3])
    expect(parseVersion("v10.0.1")).toEqual([10, 0, 1])
  })

  test("refuses anything that is not three numbers", () => {
    expect(parseVersion("ade-v1.2")).toBeUndefined()
    expect(parseVersion("1.2.3-beta.1")).toBeUndefined()
    expect(parseVersion("vscode-v1.2.3")).toBeUndefined()
  })
})

describe("newerRelease", () => {
  test("offers the highest ADE release above the running one", () => {
    const found = newerRelease("1.0.0", [release("ade-v1.1.0"), release("ade-v1.10.0"), release("ade-v1.2.0")])
    expect(found).toEqual({
      version: "1.10.0",
      url: "https://github.com/SandroHub013/nikcli/releases/tag/ade-v1.10.0",
    })
  })

  test("says nothing when the running build is current or ahead", () => {
    expect(newerRelease("1.2.0", [release("ade-v1.2.0")])).toBeUndefined()
    expect(newerRelease("1.3.0", [release("ade-v1.2.0")])).toBeUndefined()
  })

  test("ignores drafts, prereleases and other products' tags", () => {
    const releases = [
      release("ade-v9.0.0", { draft: true }),
      release("ade-v8.0.0", { prerelease: true }),
      release("v99.0.0"),
      release("vscode-v5.0.0"),
    ]
    expect(newerRelease("1.0.0", releases)).toBeUndefined()
  })

  test("never nags a dev build", () => {
    expect(newerRelease("0.0.0", [release("ade-v1.0.0")])).toBeUndefined()
    expect(newerRelease("not-a-version", [release("ade-v1.0.0")])).toBeUndefined()
  })
})

describe("isReleasePage", () => {
  test("accepts only release pages on the fork", () => {
    expect(isReleasePage("https://github.com/SandroHub013/nikcli/releases/tag/ade-v1.0.0")).toBe(true)
    expect(isReleasePage("https://github.com/nikomatt69/nikcli/releases/tag/ade-v1.0.0")).toBe(false)
    expect(isReleasePage("https://evil.example/SandroHub013/nikcli/releases/")).toBe(false)
  })
})
