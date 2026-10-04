import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import { GadgetError, LIMITS } from "@nikcli-ai/gadget/protocol"
import { Registry } from "../src/registry.ts"
import { FINGERPRINT, FakeFeed, hello, online, rejection, tempDir, throws } from "./helpers.ts"

function pairRequest(code: string, overrides: Record<string, unknown> = {}) {
  return {
    code,
    name: "pi office",
    platform: { os: "linux", arch: "arm64", machine: FINGERPRINT },
    fingerprint: FINGERPRINT,
    button: false,
    ...overrides,
  }
}

const tag = (error: unknown) => (error instanceof GadgetError ? error.tag : String(error))

describe("pairing", () => {
  test("needs an open window, and the code is single use", () => {
    const registry = new Registry()
    expect(tag(throws(() => registry.pair(pairRequest("000000"))))).toBe("PairingClosed")
    const { code } = registry.openPairing()
    const first = registry.pair(pairRequest(code))
    expect(first.id).toBe("pi-office")
    expect(first.token.startsWith("nkg_")).toBe(true)
    expect(first.confirm).toBe(false)
    expect(tag(throws(() => registry.pair(pairRequest(code, { fingerprint: "another-machine-1234" }))))).toBe(
      "PairingClosed",
    )
  })

  test("five wrong codes close the window", () => {
    const registry = new Registry()
    const { code } = registry.openPairing()
    const wrong = code === "111111" ? "222222" : "111111"
    for (let i = 0; i < 5; i++) expect(tag(throws(() => registry.pair(pairRequest(wrong))))).toBe("PairingClosed")
    expect(registry.pairing.open).toBe(false)
    expect(tag(throws(() => registry.pair(pairRequest(code))))).toBe("PairingClosed")
  })

  test("the window expires after ten minutes", () => {
    let now = 1_000
    const registry = new Registry({ now: () => now })
    const { code, expiresAt } = registry.openPairing()
    expect(expiresAt - now).toBe(LIMITS.PAIR_WINDOW_MS)
    now += LIMITS.PAIR_WINDOW_MS + 1
    expect(registry.pairing.open).toBe(false)
    expect(tag(throws(() => registry.pair(pairRequest(code))))).toBe("PairingClosed")
  })

  test("a device with a button must confirm before hello", () => {
    const registry = new Registry()
    const { code } = registry.openPairing()
    const { id, confirm } = registry.pair(pairRequest(code, { button: true }))
    expect(confirm).toBe(true)
    expect(tag(throws(() => registry.hello(id, hello())))).toBe("Unconfirmed")
    registry.confirm(id)
    expect(registry.hello(id, hello()).name).toBe("pi office")
  })

  test("the same machine pairing again keeps its id, gets a new token, and the old one is revoked", () => {
    const registry = new Registry()
    const first = registry.pair(pairRequest(registry.openPairing().code))
    const second = registry.pair(pairRequest(registry.openPairing().code))
    expect(second.id).toBe(first.id)
    expect(second.token).not.toBe(first.token)
    expect(tag(throws(() => registry.authenticate(first.token)))).toBe("TokenRevoked")
    expect(registry.authenticate(second.token).id).toBe(first.id)
    expect(registry.list()).toHaveLength(1)
  })

  test("two machines with one name get distinct ids", () => {
    const registry = new Registry()
    const a = registry.pair(pairRequest(registry.openPairing().code))
    const b = registry.pair(pairRequest(registry.openPairing().code, { fingerprint: "other-machine-12345678" }))
    expect([a.id, b.id]).toEqual(["pi-office", "pi-office-2"])
  })
})

describe("the feed", () => {
  test("opens only after a hello in this process, even though the stored declaration survives a restart", () => {
    const { dir, cleanup } = tempDir()
    try {
      const file = path.join(dir, "devices.json")
      const { id } = online({ file })
      const restarted = new Registry({ file })
      expect(restarted.get(id).commands.length).toBeGreaterThan(0)
      expect(tag(throws(() => restarted.attach(id, new FakeFeed())))).toBe("HelloInvalid")
      restarted.hello(id, hello())
      restarted.attach(id, new FakeFeed())
      expect(restarted.online(id)).toBe(true)
    } finally {
      cleanup()
    }
  })

  test("a frame bigger than the device's buffer is refused before it is sent, and the queue carries on", async () => {
    const { registry, id } = online()
    registry.hello(id, hello({ maxFrameBytes: 600 }))
    const fresh = new FakeFeed()
    registry.attach(id, fresh)
    const tooBig = registry.invoke(id, { command: "system.run", args: { argv: ["echo", "x".repeat(2_000)] } })
    const small = registry.invoke(id, { command: "system.run", args: { argv: ["true"] } })
    const error = await rejection(tooBig)
    expect(tag(error)).toBe("PayloadTooLarge")
    expect((error as GadgetError).message).toMatch(/takes frames up to 600 bytes/)
    // Nothing oversized went on the wire, and the next call was sent instead of waiting out a timeout.
    expect(fresh.invokes()).toHaveLength(1)
    registry.result(id, { callID: fresh.invokes()[0]!.callID, output: "ok" })
    expect((await small).output).toBe("ok")
  })

  test("a bitmap that does not fit the buffer is refused with the sizes", () => {
    const { registry, id } = online()
    registry.hello(
      id,
      hello({
        maxFrameBytes: 1_024,
        display: { columns: 1, rows: 1, depth: 1, format: "bitmap", width: 296, height: 128 },
      }),
    )
    registry.attach(id, new FakeFeed())
    const error = throws(() => registry.show(id, { type: "Text", props: {}, children: ["x"] })) as GadgetError
    expect(error.tag).toBe("PayloadTooLarge")
    expect(error.message).toMatch(/takes frames up to 1024 bytes.*needs \d+/)
  })
})

describe("tokens", () => {
  test("unknown and revoked tokens are told apart", () => {
    const { registry, id, token } = online()
    expect(registry.authenticate(token).id).toBe(id)
    expect(tag(throws(() => registry.authenticate("nkg_nope")))).toBe("NotPaired")
    expect(tag(throws(() => registry.authenticate(undefined)))).toBe("NotPaired")
    registry.revoke(id)
    expect(tag(throws(() => registry.authenticate(token)))).toBe("TokenRevoked")
  })

  test("the token is hashed at rest and devices survive a restart", () => {
    const { dir, cleanup } = tempDir()
    try {
      const file = path.join(dir, "devices.json")
      const { token, id } = online({ file })
      const text = readFileSync(file, "utf8")
      expect(text).not.toContain(token)
      expect(text).toContain("tokenHash")
      const again = new Registry({ file })
      expect(again.authenticate(token).id).toBe(id)
      expect(again.list()[0]?.online).toBe(false)
    } finally {
      cleanup()
    }
  })
})

describe("hello", () => {
  test("a hello from another machine is refused", () => {
    const { registry, id } = online()
    const error = throws(() =>
      registry.hello(id, hello({ platform: { os: "linux", arch: "arm64", machine: "someone-else-123456" } })),
    )
    expect(tag(error)).toBe("Denied")
  })

  test("a hello that leaves the fingerprint out is refused too", () => {
    const { registry, id } = online()
    const bare = hello({ platform: { os: "linux", arch: "arm64" } })
    expect(tag(throws(() => registry.hello(id, bare)))).toBe("Denied")
  })

  test("a bad hello leaves the previous declaration in place", () => {
    const { registry, id } = online()
    expect(
      tag(
        throws(() =>
          registry.hello(id, { ...hello(), commands: [{ name: "Bad", description: "x", args: { type: "object" } }] }),
        ),
      ),
    ).toBe("HelloInvalid")
    expect(registry.get(id).commands.map((c) => c.name)).toEqual(["device.health", "system.run", "echo.say"])
  })

  test("the feed needs a hello first", () => {
    const registry = new Registry()
    const { id } = registry.pair(pairRequest(registry.openPairing().code))
    expect(tag(throws(() => registry.attach(id, new FakeFeed())))).toBe("HelloInvalid")
  })
})

describe("invocations", () => {
  test("a command is sent with a deadline and resolves with its result", async () => {
    const { registry, id, feed } = online()
    const pending = registry.invoke(id, { command: "system.run", args: { argv: ["uptime"] } })
    const [frame] = feed.invokes()
    expect(frame?.command).toBe("system.run")
    expect(frame?.args).toEqual({ argv: ["uptime"] })
    // Relative, not an absolute time: the device's clock is not the bridge's clock.
    expect(frame?.timeoutMs).toBe(5_000)
    expect(frame && "deadline" in frame).toBe(false)
    expect(registry.result(id, { callID: frame!.callID, output: "up 1 day", exitCode: 0, isError: false })).toBe(true)
    const result = await pending
    expect(result).toMatchObject({ output: "up 1 day", exitCode: 0, isError: false, truncated: false })
  })

  test("one command is in flight; the rest wait in order", async () => {
    const { registry, id, feed } = online()
    const first = registry.invoke(id, { command: "system.run" })
    const second = registry.invoke(id, { command: "device.health" })
    expect(feed.invokes()).toHaveLength(1)
    registry.result(id, { callID: feed.invokes()[0]!.callID, output: "one" })
    await first
    expect(feed.invokes()).toHaveLength(2)
    expect(feed.invokes()[1]?.command).toBe("device.health")
    registry.result(id, { callID: feed.invokes()[1]!.callID, output: "two" })
    expect((await second).output).toBe("two")
  })

  test("past one in flight and eight waiting the next is Busy", async () => {
    const { registry, id } = online()
    const accepted = Array.from({ length: 1 + LIMITS.QUEUE_DEPTH }, () =>
      registry.invoke(id, { command: "system.run" }),
    )
    const error = await rejection(registry.invoke(id, { command: "system.run" }))
    expect(tag(error)).toBe("Busy")
    expect((error as GadgetError).retryAfterMs).toBeGreaterThan(0)
    registry.revoke(id)
    for (const promise of accepted) expect(tag(await rejection(promise))).toBe("Offline")
  })

  test("a command that does not answer times out, and its late result is discarded", async () => {
    const { registry, id, feed } = online()
    const slow = registry.invoke(id, { command: "system.run", timeoutMs: 30 })
    expect(tag(await rejection(slow))).toBe("Timeout")
    const callID = feed.invokes()[0]!.callID
    expect(registry.result(id, { callID, output: "late" })).toBe(false)
    const next = registry.invoke(id, { command: "device.health" })
    registry.result(id, { callID: feed.invokes()[1]!.callID, output: "fresh" })
    expect((await next).output).toBe("fresh")
  })

  test("the deadline starts when the command is sent, not when it was queued", async () => {
    const { registry, id, feed } = online()
    const first = registry.invoke(id, { command: "system.run", timeoutMs: 200 })
    const queued = registry.invoke(id, { command: "device.health", timeoutMs: 120 })
    await new Promise((resolve) => setTimeout(resolve, 90))
    registry.result(id, { callID: feed.invokes()[0]!.callID, output: "ok" })
    await first
    await new Promise((resolve) => setTimeout(resolve, 60))
    // 150 ms have passed since queueing: past its 120 ms budget, but it only started 60 ms ago.
    registry.result(id, { callID: feed.invokes()[1]!.callID, output: "in time" })
    expect((await queued).output).toBe("in time")
  })

  test("an unknown command and an offline device fail fast", async () => {
    const { registry, id } = online()
    expect(tag(await rejection(registry.invoke(id, { command: "nope.x" })))).toBe("CommandUnknown")
    const idle = new Registry()
    const { id: other } = idle.pair(pairRequest(idle.openPairing().code))
    expect(tag(await rejection(idle.invoke(other, { command: "system.run" })))).toBe("Offline")
  })

  test("a feed that goes away fails everything waiting with Offline", async () => {
    const registry = new Registry()
    const { id } = registry.pair(pairRequest(registry.openPairing().code))
    registry.hello(id, hello())
    const feed = new FakeFeed()
    const detach = registry.attach(id, feed)
    const running = registry.invoke(id, { command: "system.run" })
    const waiting = registry.invoke(id, { command: "device.health" })
    detach()
    expect(tag(await rejection(running))).toBe("Offline")
    expect(tag(await rejection(waiting))).toBe("Offline")
    expect(registry.online(id)).toBe(false)
  })

  test("a feed that cannot take a frame is evicted and the caller is told", async () => {
    const { registry, id, feed } = online()
    feed.full = true
    expect(tag(await rejection(registry.invoke(id, { command: "system.run" })))).toBe("Offline")
    expect(registry.online(id)).toBe(false)
    expect(feed.closed).toBe("feed fell behind")
  })

  test("output past the command's limit is cut and marked", async () => {
    const { registry, id, feed } = online()
    const pending = registry.invoke(id, { command: "echo.say" })
    registry.result(id, { callID: feed.invokes()[0]!.callID, output: "0123456789" })
    expect(await pending).toMatchObject({ output: "01234567", truncated: true })
  })

  test("a newer connection replaces the old feed", () => {
    const { registry, id, feed } = online()
    registry.attach(id, new FakeFeed())
    expect(feed.closed).toBe("replaced by a newer connection")
    expect(registry.online(id)).toBe(true)
  })
})

describe("display and messages", () => {
  test("show needs a display and a drawable tree", () => {
    const plain = online()
    expect(tag(throws(() => plain.registry.show(plain.id, { type: "Text", props: {}, children: ["x"] })))).toBe(
      "CommandUnknown",
    )
    const { registry, id, feed } = online({ display: true })
    expect(tag(throws(() => registry.show(id, { type: "Image" })))).toBe("PayloadTooLarge")
    const frameID = registry.show(id, { type: "Markdown", props: { text: "# hi" } })
    const shown = feed.frames.find((frame) => frame.type === "show")
    expect(shown).toMatchObject({ type: "show", frameID, viewport: { columns: 20, rows: 4 } })
  })

  test("a bitmap display is sent finished pixels the bridge rendered", () => {
    const { registry, id, feed } = online()
    registry.hello(id, hello({ display: { columns: 1, rows: 1, depth: 1, format: "bitmap", width: 48, height: 16 } }))
    const fresh = new FakeFeed()
    registry.attach(id, fresh)
    const frameID = registry.show(id, { type: "Text", props: {}, children: ["ok"] })
    const shown = fresh.frames.find((frame) => frame.type === "show")
    expect(shown).toMatchObject({ type: "show", frameID, bitmap: { width: 48, height: 16, format: "1bpp" } })
    expect(shown && "tree" in shown).toBe(false)
    const data = Buffer.from((shown as { bitmap: { data: string } }).bitmap.data, "base64")
    expect(data.byteLength).toBe(6 * 16)
    expect(data.some((byte) => byte !== 0)).toBe(true)
    expect(feed.frames.some((frame) => frame.type === "show")).toBe(false)
  })

  test("sixty messages a minute, then RateLimited with a retry time", () => {
    let now = 10_000
    const { registry, id } = online({ now: () => now })
    for (let i = 0; i < LIMITS.MESSAGE_RATE_PER_MIN; i++) registry.admitMessage(id, "hi")
    const error = throws(() => registry.admitMessage(id, "hi")) as GadgetError
    expect(error.tag).toBe("RateLimited")
    expect(error.retryAfterMs).toBeGreaterThan(0)
    now += 60_001
    registry.admitMessage(id, "hi")
  })

  test("the message limit holds for a device with no feed open, which is how `send` works", () => {
    let now = 10_000
    const registry = new Registry({ now: () => now })
    const { id } = registry.pair(pairRequest(registry.openPairing().code))
    expect(registry.online(id)).toBe(false)
    for (let i = 0; i < LIMITS.MESSAGE_RATE_PER_MIN; i++) registry.admitMessage(id, "hi")
    expect(tag(throws(() => registry.admitMessage(id, "hi")))).toBe("RateLimited")
    now += 60_001
    registry.admitMessage(id, "hi")
  })

  test("a device may continue only the sessions it started, and the list is capped", () => {
    const { registry, id } = online()
    expect(registry.ownsSession(id, "ses_a")).toBe(false)
    registry.rememberSession(id, "ses_a")
    expect(registry.ownsSession(id, "ses_a")).toBe(true)
    for (let i = 0; i < 60; i++) registry.rememberSession(id, `ses_${i}`)
    expect(registry.ownsSession(id, "ses_a")).toBe(false)
    expect(registry.ownsSession(id, "ses_59")).toBe(true)
  })

  test("an empty message is a bad request", () => {
    const { registry, id } = online()
    expect(tag(throws(() => registry.admitMessage(id, "  ")))).toBe("BadRequest")
  })
})

describe("revoke", () => {
  test("says goodbye, closes the feed and forgets the device", () => {
    const { registry, id, feed } = online()
    registry.revoke(id)
    expect(feed.frames.at(-1)).toEqual({ type: "bye", reason: "revoked" })
    expect(feed.closed).toBe("revoked")
    expect(registry.list()).toHaveLength(0)
  })
})
