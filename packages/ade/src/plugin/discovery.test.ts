import { describe, expect, test } from "bun:test"
import {
  discoverPlugins,
  isPathSpec,
  parseDeclaredPlugins,
  resolveDeclaredPlugin,
  resolveManifestEntry,
  specToUrl,
  urlToPath,
  type DiscoveryIO,
} from "./discovery"

/** A fake disk: paths to contents. Anything absent does not exist. */
function io(files: Record<string, string>): DiscoveryIO {
  const normal = (path: string) => path.replace(/\\/g, "/")
  const table = Object.fromEntries(Object.entries(files).map(([key, value]) => [normal(key), value]))
  return {
    async exists(path) {
      return normal(path) in table
    },
    async readTextFile(path) {
      const text = table[normal(path)]
      if (text === undefined) throw new Error(`ENOENT ${path}`)
      return { text }
    },
  }
}

describe("parseDeclaredPlugins", () => {
  test("reads the same `plugin` array the TUI reads, in both spec forms", () => {
    const text = JSON.stringify({ plugin: ["file:///a/b", ["file:///c", { token: 1 }]] })
    expect(parseDeclaredPlugins(text)).toEqual([{ spec: "file:///a/b" }, { spec: "file:///c", options: { token: 1 } }])
  })

  /*
   * A half-edited config must not stop ADE from starting. Everything that
   * cannot be read yields no plugins rather than an exception.
   */
  test("a config that will not parse yields nothing", () => {
    expect(parseDeclaredPlugins("{ not json")).toEqual([])
    expect(parseDeclaredPlugins("null")).toEqual([])
    expect(parseDeclaredPlugins("{}")).toEqual([])
    expect(parseDeclaredPlugins(JSON.stringify({ plugin: "one" }))).toEqual([])
  })

  test("entries that are not specifiers are skipped, the rest are kept", () => {
    const text = JSON.stringify({ plugin: [42, null, "  ", "./real", {}] })
    expect(parseDeclaredPlugins(text)).toEqual([{ spec: "./real" }])
  })
})

describe("specToUrl", () => {
  test("a relative spec resolves against the project root", () => {
    expect(specToUrl("./plugin/a.js", "C:/repo")).toBe("file:///C:/repo/plugin/a.js")
    expect(specToUrl("plugin/a.js", "/home/me/repo")).toBe("file:///home/me/repo/plugin/a.js")
  })

  /*
   * `new URL` treats a backslash as an ordinary character, so an unnormalised
   * Windows root becomes one opaque segment and every relative resolution
   * against it lands somewhere else entirely.
   */
  test("a Windows path is normalised before it is made a URL", () => {
    expect(specToUrl("C:\\repo\\plugin\\a.js", "C:/other")).toBe("file:///C:/repo/plugin/a.js")
    expect(specToUrl("./plugin/a.js", "C:\\repo")).toBe("file:///C:/repo/plugin/a.js")
  })

  test("a file:// spec is left as it is", () => {
    expect(specToUrl("file:///C:/repo/a.js", "C:/other")).toBe("file:///C:/repo/a.js")
  })

  test("a URL round-trips back to something the host can open", () => {
    expect(urlToPath("file:///C:/repo/a.js")).toBe("C:/repo/a.js")
    expect(urlToPath("file:///home/me/a.js")).toBe("/home/me/a.js")
    expect(urlToPath("file:///C:/re%20po/a.js")).toBe("C:/re po/a.js")
  })

  test("only a path-shaped spec is one; a package name is not", () => {
    expect(isPathSpec("./a")).toBe(true)
    expect(isPathSpec("/a")).toBe(true)
    expect(isPathSpec("C:\\a")).toBe(true)
    expect(isPathSpec("file:///a")).toBe(true)
    expect(isPathSpec("nikcli-plugin-foo")).toBe(false)
    expect(isPathSpec("@scope/plugin@1.2.3")).toBe(false)
  })
})

describe("resolveManifestEntry", () => {
  const manifest = "file:///C:/repo/plugin/package.json"

  test("takes exports['./ade'], in either form", () => {
    expect(resolveManifestEntry(manifest, JSON.stringify({ exports: { "./ade": "./dist/ade.js" } }))).toEqual({
      entry: "file:///C:/repo/plugin/dist/ade.js",
    })
    expect(
      resolveManifestEntry(manifest, JSON.stringify({ exports: { "./ade": { import: "./dist/ade.js" } } })),
    ).toEqual({ entry: "file:///C:/repo/plugin/dist/ade.js" })
  })

  /*
   * Which surface a plugin serves is the package's own declaration, and it is
   * the same declaration the TUI reads through `resolvePluginEntrypoint`. A
   * terminal-only plugin is simply not offered here.
   */
  test("a package that declares only ./tui is not an ADE plugin", () => {
    const outcome = resolveManifestEntry(manifest, JSON.stringify({ exports: { "./tui": "./dist/tui.js" } }))
    expect(outcome).toEqual({ reason: 'il pacchetto non dichiara exports["./ade"]' })
  })

  /*
   * The same rule `resolvePluginEntrypoint` enforces with
   * `Filesystem.contains`, in the only vocabulary a webview has.
   */
  test("an entrypoint may not escape the package directory", () => {
    const outcome = resolveManifestEntry(
      manifest,
      JSON.stringify({ exports: { "./ade": "../../../Windows/System32/evil.js" } }),
    )
    expect(outcome).toEqual({ reason: "l'entrypoint del plugin esce dalla cartella del pacchetto" })
  })

  test("an unreadable manifest says so", () => {
    expect(resolveManifestEntry(manifest, "{ nope")).toEqual({ reason: "package.json non è JSON valido" })
  })
})

describe("resolveDeclaredPlugin", () => {
  test("a spec naming a JavaScript file is the entry", async () => {
    const outcome = await resolveDeclaredPlugin({ spec: "./p/a.js" }, "C:/repo", io({ "C:/repo/p/a.js": "" }))
    expect(outcome).toEqual({ spec: "./p/a.js", entry: "file:///C:/repo/p/a.js" })
  })

  test("a spec naming a directory goes through its package.json", async () => {
    const outcome = await resolveDeclaredPlugin(
      { spec: "./p", options: { k: 1 } },
      "C:/repo",
      io({
        "C:/repo/p/package.json": JSON.stringify({ exports: { "./ade": "./dist/ade.js" } }),
        "C:/repo/p/dist/ade.js": "",
      }),
    )
    expect(outcome).toEqual({ spec: "./p", options: { k: 1 }, entry: "file:///C:/repo/p/dist/ade.js" })
  })

  test("a declared entrypoint that is not on disk is reported, not returned", async () => {
    const outcome = await resolveDeclaredPlugin(
      { spec: "./p" },
      "C:/repo",
      io({ "C:/repo/p/package.json": JSON.stringify({ exports: { "./ade": "./dist/ade.js" } }) }),
    )
    expect(outcome).toEqual({ spec: "./p", reason: "l'entrypoint dichiarato non esiste" })
  })

  /*
   * Resolving an npm specifier means installing it, which is `bun install`,
   * which is the host's job. Refused with a reason rather than attempted and
   * failed with something about a module not being found.
   */
  test("an npm specifier is refused with a reason a user can act on", async () => {
    const outcome = await resolveDeclaredPlugin({ spec: "nikcli-plugin-foo" }, "C:/repo", io({}))
    expect("reason" in outcome && outcome.reason).toContain("terminale")
  })
})

describe("discoverPlugins", () => {
  const config = (plugins: unknown[]) => JSON.stringify({ plugin: plugins })

  test("sorts what the project declares into what loads and what does not", async () => {
    const found = await discoverPlugins(
      "C:/repo",
      io({
        "C:/repo/.nikcli/tui.json": config(["./good.js", "./missing.js", "nikcli-plugin-foo"]),
        "C:/repo/good.js": "",
      }),
    )
    expect(found.resolved).toEqual([{ spec: "./good.js", entry: "file:///C:/repo/good.js" }])
    expect(found.rejected.map((item) => item.spec)).toEqual(["./missing.js", "nikcli-plugin-foo"])
  })

  test("no config is not an error", async () => {
    expect(await discoverPlugins("C:/repo", io({}))).toEqual({ resolved: [], rejected: [] })
  })

  test("the config path is the one the TUI already writes", async () => {
    const found = await discoverPlugins(
      "C:/repo",
      io({ "C:/repo/.nikcli/tui.json": config(["./a.js"]), "C:/repo/a.js": "" }),
    )
    expect(found.resolved).toHaveLength(1)
  })
})
