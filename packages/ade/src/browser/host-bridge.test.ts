import { describe, expect, test } from "bun:test"
import { framingBlocked } from "./handshake"
import { canOpenExternally, probeFraming, readHeaders } from "./host-bridge"

describe("host bridge", () => {
  test("the host's headers are read the way framingBlocked reads a response", () => {
    expect(framingBlocked(readHeaders({ xFrameOptions: "SAMEORIGIN", csp: null }))).toBe(true)
    expect(framingBlocked(readHeaders({ xFrameOptions: null, csp: "frame-ancestors 'self'" }))).toBe(true)
    expect(framingBlocked(readHeaders({ xFrameOptions: null, csp: "default-src *" }))).toBe(false)
    expect(framingBlocked(readHeaders(undefined))).toBe(false)
  })

  test("outside the desktop app there is no probe and no system browser", async () => {
    expect(await probeFraming("https://a.test/")).toBeUndefined()
    expect(canOpenExternally()).toBe(false)
  })
})
