import { describe, expect, it } from "bun:test"
import {
  Capability,
  CapabilityDenied,
  Incompatible,
  ManifestInvalid,
  hasManifest,
  parseManifest,
} from "@nikcli-ai/plugin/v2/manifest"

/**
 * EOT-14 v2 plugin manifest contract.
 *
 * The v2 manifest is the discriminator between a v2 plugin module and a
 * v1 one (`hasManifest` is the test). `parseManifest` is the typed loader;
 * it must throw `ManifestInvalid` on a malformed manifest and never silently
 * fall back to the v1 path. `CapabilityDenied` is what a host hands back
 * when a plugin asks for a capability the host cannot supply.
 *
 * These tests pin the requirements in
 * `specs/effect-tui/14-plugin-v2-architecture.md`:
 *   - 1. Empty module is rejected (compatibility failure).
 *   - 2. `parseManifest` throws, never returns an Option.
 *   - 6. Capability gating is a typed failure with the host's reason.
 *  - 11. `hasManifest` is the discriminator.
 *
 * All tests are pure — no IO, no DB, no network.
 */

const validManifest = {
  id: "nikcli:smoke",
  version: "1.0.0",
  kind: "user",
  capabilities: ["tools"],
}

describe("EOT-14 v2 manifest parseManifest", () => {
  it("accepts a well-formed manifest", () => {
    const m = parseManifest(validManifest, "test://valid")
    expect(m.id).toBe("nikcli:smoke")
    expect(m.version).toBe("1.0.0")
    expect(m.kind).toBe("user")
    expect(m.capabilities).toEqual(["tools"])
  })

  it("rejects a non-object payload with ManifestInvalid", () => {
    expect(() => parseManifest(null, "test://null")).toThrow(ManifestInvalid)
    expect(() => parseManifest("string", "test://string")).toThrow(ManifestInvalid)
    expect(() => parseManifest([], "test://array")).toThrow(ManifestInvalid)
  })

  it("rejects a non-scoped or non-lowercase id", () => {
    expect(() => parseManifest({ ...validManifest, id: "noScope" }, "test://no-scope")).toThrow(ManifestInvalid)
    expect(() => parseManifest({ ...validManifest, id: "Org:Smoke" }, "test://caps")).toThrow(ManifestInvalid)
    expect(() => parseManifest({ ...validManifest, id: ":leading-colon" }, "test://leading")).toThrow(ManifestInvalid)
    expect(() => parseManifest({ ...validManifest, id: "trailing-colon:" }, "test://trailing")).toThrow(ManifestInvalid)
  })

  it("rejects a non-semver version", () => {
    expect(() => parseManifest({ ...validManifest, version: "1" }, "test://not-semver")).toThrow(ManifestInvalid)
    expect(() => parseManifest({ ...validManifest, version: "v1.0.0" }, "test://v-prefix")).toThrow(ManifestInvalid)
    expect(() => parseManifest({ ...validManifest, version: "1.0" }, "test://short")).toThrow(ManifestInvalid)
  })

  it("rejects an unknown kind", () => {
    expect(() => parseManifest({ ...validManifest, kind: "rogue" }, "test://bad-kind")).toThrow(ManifestInvalid)
  })

  it("rejects a missing capabilities array", () => {
    const { capabilities: _, ...rest } = validManifest
    expect(() => parseManifest(rest, "test://no-caps")).toThrow(ManifestInvalid)
  })

  it("rejects an unknown capability value with a typed reason", () => {
    try {
      parseManifest({ ...validManifest, capabilities: ["eject-seat"] }, "test://bad-cap")
      expect.unreachable()
    } catch (error) {
      expect(error).toBeInstanceOf(ManifestInvalid)
      const mi = error as ManifestInvalid
      expect(mi._tag).toBe("PluginV2ManifestInvalid")
      expect(mi.reason).toContain("unknown capability")
      expect(mi.spec).toBe("test://bad-cap")
      // The message the human sees is populated (loader contract).
      expect(mi.message).toContain("test://bad-cap")
    }
  })

  it("rejects an empty capabilities array", () => {
    expect(() => parseManifest({ ...validManifest, capabilities: [] }, "test://empty")).toThrow(ManifestInvalid)
  })

  it("preserves hostRequirements and permissions when present", () => {
    const parsed = parseManifest(
      {
        ...validManifest,
        hostRequirements: { nikcli: ">=1.0.0", effect: ">=4.0.0" },
        permissions: { filesystem: ["read:/tmp"], network: ["api.openai.com"] },
      },
      "test://full",
    )
    expect(parsed.hostRequirements?.nikcli).toBe(">=1.0.0")
    expect(parsed.hostRequirements?.effect).toBe(">=4.0.0")
    expect(parsed.permissions?.filesystem).toEqual(["read:/tmp"])
    expect(parsed.permissions?.network).toEqual(["api.openai.com"])
  })

  it("every capability literal is reachable", () => {
    for (const cap of Capability.literals) {
      const parsed = parseManifest({ ...validManifest, capabilities: [cap] }, `test://${cap}`)
      expect(parsed.capabilities).toContain(cap)
    }
  })
})

describe("EOT-14 v2 manifest hasManifest discriminator", () => {
  it("returns true when the module carries a manifest field", () => {
    expect(hasManifest({ manifest: validManifest })).toBe(true)
  })

  it("returns false for a v1-style module without a manifest field", () => {
    expect(hasManifest({})).toBe(false)
    expect(hasManifest({ tool: () => {} })).toBe(false)
    expect(hasManifest(null)).toBe(false)
    expect(hasManifest(undefined)).toBe(false)
    expect(hasManifest("string")).toBe(false)
  })
})

describe("EOT-14 v2 manifest typed errors", () => {
  it("CapabilityDenied carries the host's reason", () => {
    const error = new CapabilityDenied({
      pluginID: "nikcli:smoke",
      capability: "http",
      reason: "host has no outbound HTTP capability",
    })
    expect(error._tag).toBe("PluginV2CapabilityDenied")
    expect(error.pluginID).toBe("nikcli:smoke")
    expect(error.capability).toBe("http")
    expect(error.message).toContain("http")
    expect(error.message).toContain("host has no outbound HTTP capability")
  })

  it("Incompatible reports the requirement + actual host version", () => {
    const error = new Incompatible({
      pluginID: "nikcli:smoke",
      requirement: "nikcli",
      required: ">=2.0.0",
      actual: "1.374.0",
    })
    expect(error._tag).toBe("PluginV2Incompatible")
    expect(error.message).toContain(">=2.0.0")
    expect(error.message).toContain("1.374.0")
  })

  it("ManifestInvalid carries spec + reason + a populated message", () => {
    const error = new ManifestInvalid({
      spec: "test://spec",
      reason: "demonstration",
    })
    expect(error._tag).toBe("PluginV2ManifestInvalid")
    expect(error.message).toContain("test://spec")
    expect(error.message).toContain("demonstration")
  })
})
