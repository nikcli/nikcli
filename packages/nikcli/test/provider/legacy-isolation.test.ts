import { describe, expect, it } from "bun:test"
import { Glob } from "bun"
import path from "path"

/**
 * The AI SDK is the **fallback** runtime: native `@nikcli-ai/llm` is the default, and `ai` / `@ai-sdk/*` /
 * `@openrouter/ai-sdk-provider` / `@gitlab/gitlab-ai-provider` are kept behind the `provider/legacy/*`
 * boundary so the rest of nikcli reaches providers through `@nikcli-ai/llm` alone.
 *
 * The re-export barrier (`provider/legacy/ai-sdk.ts`) is the only place the AI SDK is imported by the
 * general code; the vendored GitHub Copilot provider ships with its own `@ai-sdk/provider` /
 * `provider-utils` imports under `provider/legacy/copilot/*` (this is the supported way to keep
 * copilot on the AI SDK surface).
 */
const SDK =
  /(?:from|import\()\s*["'](?:ai|@ai-sdk\/[^"']+|@openrouter\/ai-sdk-provider|@gitlab\/gitlab-ai-provider)["']/

async function offenders(root: string) {
  const found: string[] = []
  for await (const file of new Glob("**/*.{ts,tsx}").scan({ cwd: root })) {
    if (SDK.test(await Bun.file(path.join(root, file)).text())) found.push(file)
  }
  return found
}

describe("AI SDK isolation", () => {
  it("is only imported inside the provider/legacy barrier", async () => {
    const off = await offenders(path.resolve(import.meta.dir, "../../src"))
    const outside = off.filter((file) => !file.startsWith("provider/legacy/"))
    expect(outside).toEqual([])
  })

  it("is not imported by @nikcli-ai/llm", async () => {
    expect(await offenders(path.resolve(import.meta.dir, "../../../llm/src"))).toEqual([])
  })

  it("is a transitive dependency of nikcli (kept behind the barrier)", async () => {
    const json = await Bun.file(path.resolve(import.meta.dir, "../../package.json")).json()
    const names = Object.keys({
      ...json.dependencies,
      ...json.devDependencies,
    })
    expect(
      names.filter((name) => name === "ai" || name.startsWith("@ai-sdk/") || name.includes("ai-sdk-provider")),
    ).not.toEqual([])
  })

  it("is not a dependency of @nikcli-ai/llm", async () => {
    const json = await Bun.file(path.resolve(import.meta.dir, "../../../llm/package.json")).json()
    const names = Object.keys({
      ...json.dependencies,
      ...json.devDependencies,
    })
    expect(
      names.filter((name) => name === "ai" || name.startsWith("@ai-sdk/") || name.includes("ai-sdk-provider")),
    ).toEqual([])
  })
})
