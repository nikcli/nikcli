import { describe, expect, it } from "bun:test"
import { MobileAuth } from "@/mobile/auth"

/**
 * Per-device capabilities, EOT-19 requirement 9.
 *
 * The bridge advertises what a paired device may reach, and a device without a
 * capability cannot use the operation it guards. The failure has to be visible:
 * a silent no-op shows the phone a button that does nothing, and the user
 * concludes the host is broken rather than that the device is not allowed.
 */
describe("MobileAuth capabilities", () => {
  it("gives a paired phone the full operator set", () => {
    expect(MobileAuth.can("mobile", "pty")).toBe(true)
    expect(MobileAuth.can("mobile", "teleport")).toBe(true)
    expect(MobileAuth.can("mobile", "git")).toBe(true)
  })

  it("keeps a sync transport out of operator surfaces", () => {
    // `cli-sync` moves journal rows. It has no business opening a pty or
    // reading a working tree.
    expect(MobileAuth.can("cli-sync", "read")).toBe(true)
    expect(MobileAuth.can("cli-sync", "pty")).toBe(false)
    expect(MobileAuth.can("cli-sync", "teleport")).toBe(false)
    expect(MobileAuth.can("cli-sync", "git")).toBe(false)
  })

  it("gives the desktop UI everything except device-local surfaces", () => {
    expect(MobileAuth.can("studio", "write")).toBe(true)
    expect(MobileAuth.can("studio", "git")).toBe(true)
    expect(MobileAuth.can("studio", "pty")).toBe(false)
  })

  it("grants nothing to a scope this build does not recognise", () => {
    // A token whose scope is unknown came from a newer or a forged issuer, and
    // guessing generously is the wrong direction to guess.
    expect(MobileAuth.capabilities("wormhole")).toEqual([])
    expect(MobileAuth.can("wormhole", "read")).toBe(false)
  })

  it("advertises the set the handshake will send", () => {
    expect([...MobileAuth.capabilities("mobile")].sort()).toEqual(["git", "pty", "read", "teleport", "write"])
  })
})

/**
 * The half that turns the table above into enforcement.
 *
 * Until 2026-09-21 `can` had zero production call sites: the capabilities were
 * declared, tested, and consulted by nobody, so a `cli-sync` token could open a
 * pty. `requiredCapability` is the path side of the pairing, evaluated once in
 * `Auth.authenticate`.
 */
describe("MobileAuth.requiredCapability", () => {
  it("guards every pty entry point, including the raw connect route", () => {
    // `/pty/:id/connect` is served outside the `/mobile` group (it is in
    // `rawRouteImplementations`). Guarding create while leaving connect open
    // would be a hole of exactly the kind this pairing exists to close.
    expect(MobileAuth.requiredCapability("/mobile/pty")).toBe("pty")
    expect(MobileAuth.requiredCapability("/mobile/pty/pty_123")).toBe("pty")
    expect(MobileAuth.requiredCapability("/pty/pty_123/connect")).toBe("pty")
  })

  it("guards teleport wherever it appears in the path", () => {
    expect(MobileAuth.requiredCapability("/mobile/teleport")).toBe("teleport")
    expect(MobileAuth.requiredCapability("/mobile/teleport/upload")).toBe("teleport")
    expect(MobileAuth.requiredCapability("/mobile/session/ses_1/teleport")).toBe("teleport")
  })

  it("guards the git and github surfaces", () => {
    expect(MobileAuth.requiredCapability("/mobile/git/status")).toBe("git")
    expect(MobileAuth.requiredCapability("/mobile/github/repos")).toBe("git")
  })

  it("requires nothing of the routes read and write would cover", () => {
    // Deliberate, and stated in the source: `/sync/*` moves journal rows for
    // `cli-sync`, whose only capability is `read`, so a hasty `write` rule
    // there stops sync dead. The narrow hole beats the wrong rule.
    expect(MobileAuth.requiredCapability("/mobile/session")).toBeUndefined()
    expect(MobileAuth.requiredCapability("/sync/outbox")).toBeUndefined()
    expect(MobileAuth.requiredCapability("/config")).toBeUndefined()
  })

  it("leaves a paired phone able to reach everything it is guarded on", () => {
    // The regression that matters most: this pairing must not lock out the
    // device it was written for.
    for (const pathname of ["/mobile/pty", "/mobile/teleport", "/mobile/git/status", "/pty/p/connect"]) {
      const required = MobileAuth.requiredCapability(pathname)
      expect(required).toBeTruthy()
      expect(MobileAuth.can("mobile", required!)).toBe(true)
    }
  })

  it("stops a sync token on every guarded path", () => {
    for (const pathname of ["/mobile/pty", "/mobile/teleport", "/mobile/git/status"]) {
      expect(MobileAuth.can("cli-sync", MobileAuth.requiredCapability(pathname)!)).toBe(false)
    }
  })
})

/**
 * The routes a `cli-sync` token reaches at all.
 *
 * `requiredCapability` leaves `read`/`write` unclassified, so on its own it let
 * a sync token — a credential handed to a remote hub — reach sessions, config
 * and files. That scope is an allowlist of the sync transport's own routes.
 */
describe("MobileAuth.scopeReaches", () => {
  it("lets a sync token reach exactly the transport's routes", () => {
    for (const pathname of ["/sync/event", "/sync/outbox", "/sync/stream", "/sync/snapshot/ses_1", "/sync/outbox/"]) {
      expect(MobileAuth.scopeReaches("cli-sync", pathname)).toBe(true)
    }
  })

  it("keeps a sync token off every other route, sync administration included", () => {
    for (const pathname of [
      "/mobile/session",
      "/session",
      "/config",
      "/file/content",
      "/sync/config",
      "/sync/connect",
      "/sync/disconnect",
      "/sync/drain",
      "/sync/stats",
      "/sync/snapshot/ses_1/extra",
      "/sync/eventually",
    ]) {
      expect(MobileAuth.scopeReaches("cli-sync", pathname)).toBe(false)
    }
  })

  it("does not narrow the other scopes", () => {
    for (const scope of ["mobile", "studio"]) {
      expect(MobileAuth.scopeReaches(scope, "/mobile/session")).toBe(true)
      expect(MobileAuth.scopeReaches(scope, "/config")).toBe(true)
    }
  })
})
