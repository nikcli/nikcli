import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { Config } from "@/config/config"
import { ConfigHttpApi } from "@/server/httpapi/config"

/**
 * `GET /config` is an Effect `handle()`, so its response is encoded against the
 * contract at request time — a schema that does not match a real config file is
 * a broken endpoint, not a cosmetic type. The schema is derived from the zod in
 * `config/config.ts` (see `util/zod-effect.ts`), and these tests pin the parts
 * of that derivation that runtime behaviour depends on.
 */
describe("ConfigHttpApi.Info", () => {
  const encode = Schema.encodeUnknownSync(ConfigHttpApi.Info as never)
  // Handlers push bodies through a JSON round-trip, which drops `undefined`.
  const jsonSafe = <T>(value: T): T => JSON.parse(JSON.stringify(value ?? null)) as T
  const roundtrip = (input: unknown) => encode(jsonSafe(Config.Info.parse(input))) as Record<string, unknown>

  test("encodes an empty config", () => {
    expect(roundtrip({})).toEqual({})
  })

  test("encodes a config that exercises the whole document", () => {
    const encoded = roundtrip({
      $schema: "https://nikcli-ai.dev/config.json",
      theme: "dark",
      locale: { language: "it", replyLanguage: true },
      keybinds: { session_parent: "ctrl+b" },
      logLevel: "INFO",
      plugin: ["file://./plugin.ts"],
      snapshot: true,
      reference: { docs: { type: "git", repository: "https://example.com/x.git" } },
      mcp: { local: { type: "local", command: ["bun", "x"], enabled: true } },
      permission: { bash: "ask", edit: { "*": "allow" } },
      agent: { build: { model: "anthropic/claude-opus-5", steps: 3 } },
      ads: { enabled: true, items: [{ id: "a1", text: "hi", enabled: true }] },
      disabled_providers: ["openai"],
    })

    expect(encoded.theme).toBe("dark")
    expect(encoded.keybinds).toMatchObject({ session_parent: "ctrl+b" })
    expect(encoded.plugin).toEqual(["file://./plugin.ts"])
    expect(encoded.disabled_providers).toEqual(["openai"])
  })

  test("keeps the rule map produced by the permission transform", () => {
    // `permissionTransform` rewrites a union into a flat map, so the shape is
    // pinned by hand via `overrideZod` rather than read off the zod graph.
    const encoded = roundtrip({ permission: { bash: "ask", edit: { "src/**": "deny" } } })
    expect(encoded.permission).toEqual({ bash: "ask", edit: { "src/**": "deny" } })
  })

  test("a string permission expands to a wildcard rule", () => {
    expect(roundtrip({ permission: "deny" }).permission).toEqual({ "*": "deny" })
  })

  test("keeps unknown keys on objects that declare a zod catchall", () => {
    // `Config.Agent` is `.catchall(z.any())`; dropping those keys here would
    // silently strip user config on every read.
    const encoded = roundtrip({ agent: { build: { model: "a/b", house_rule: { nested: true } } } })
    expect((encoded.agent as Record<string, Record<string, unknown>>).build.house_rule).toEqual({ nested: true })
  })

  test("rejects a value the config schema does not describe", () => {
    expect(() => encode({ theme: 42 })).toThrow()
  })
})
