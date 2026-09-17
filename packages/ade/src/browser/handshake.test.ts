import { describe, expect, test } from "bun:test"
import {
  HANDSHAKE_TIMEOUT_MS,
  INITIAL_HANDSHAKE_STATE,
  bridgelessChoice,
  framingBlocked,
  handshakeReducer,
  noticeWithoutCopy,
  reduceFidelity,
} from "./handshake"

describe("handshake constants", () => {
  test("defines handshake timeout as 1500ms", () => {
    expect(HANDSHAKE_TIMEOUT_MS).toBe(1500)
  })

  test("initial state is pending", () => {
    expect(INITIAL_HANDSHAKE_STATE.fidelity).toBe("pending")
    expect(INITIAL_HANDSHAKE_STATE.error).toBeUndefined()
  })
})

describe("handshakeReducer", () => {
  describe("transitions from pending", () => {
    test("ready event promotes pending to native", () => {
      const next = handshakeReducer({ fidelity: "pending" }, { type: "ready" })
      expect(next.fidelity).toBe("native")
      expect(next.error).toBeUndefined()
    })

    test("ready event with explicit mirror mode sets mirror", () => {
      const next = handshakeReducer({ fidelity: "pending" }, { type: "ready", mode: "mirror" })
      expect(next.fidelity).toBe("mirror")
    })

    test("timeout event transitions pending to mirror fallback", () => {
      const next = handshakeReducer({ fidelity: "pending" }, { type: "timeout" })
      expect(next.fidelity).toBe("mirror")
    })

    test("load-error event transitions pending to none with error message", () => {
      const next = handshakeReducer(
        { fidelity: "pending" },
        { type: "load-error", error: "Connection refused" },
      )
      expect(next.fidelity).toBe("none")
      expect(next.error).toBe("Connection refused")
    })

    test("navigate event keeps state pending", () => {
      const next = handshakeReducer({ fidelity: "pending" }, { type: "navigate", url: "localhost:3000" })
      expect(next.fidelity).toBe("pending")
    })
  })

  describe("transitions from native", () => {
    test("late timeout does not degrade native state", () => {
      const next = handshakeReducer({ fidelity: "native" }, { type: "timeout" })
      expect(next.fidelity).toBe("native")
    })

    test("subsequent ready keeps native state", () => {
      const next = handshakeReducer({ fidelity: "native" }, { type: "ready" })
      expect(next.fidelity).toBe("native")
    })

    test("navigate resets native state back to pending", () => {
      const next = handshakeReducer({ fidelity: "native" }, { type: "navigate", url: "localhost:5173" })
      expect(next.fidelity).toBe("pending")
    })

    test("load-error transitions native to none", () => {
      const next = handshakeReducer({ fidelity: "native" }, { type: "load-error", error: "Network lost" })
      expect(next.fidelity).toBe("none")
      expect(next.error).toBe("Network lost")
    })
  })

  describe("transitions from mirror", () => {
    test("ready keeps mirror state", () => {
      const next = handshakeReducer({ fidelity: "mirror" }, { type: "ready" })
      expect(next.fidelity).toBe("mirror")
    })

    test("late timeout keeps mirror state", () => {
      const next = handshakeReducer({ fidelity: "mirror" }, { type: "timeout" })
      expect(next.fidelity).toBe("mirror")
    })

    test("navigate resets mirror state back to pending", () => {
      const next = handshakeReducer({ fidelity: "mirror" }, { type: "navigate", url: "localhost:3000" })
      expect(next.fidelity).toBe("pending")
    })

    test("load-error transitions mirror to none", () => {
      const next = handshakeReducer({ fidelity: "mirror" }, { type: "load-error", error: "CORS fetch failed" })
      expect(next.fidelity).toBe("none")
      expect(next.error).toBe("CORS fetch failed")
    })
  })

  describe("transitions from none", () => {
    test("navigate resets none state back to pending", () => {
      const next = handshakeReducer(
        { fidelity: "none", error: "Previous error" },
        { type: "navigate", url: "localhost:3000" },
      )
      expect(next.fidelity).toBe("pending")
      expect(next.error).toBeUndefined()
    })

    test("timeout has no effect on none state", () => {
      const next = handshakeReducer({ fidelity: "none", error: "Failed" }, { type: "timeout" })
      expect(next.fidelity).toBe("none")
      expect(next.error).toBe("Failed")
    })

    test("late ready can promote none to native if bridge arrives", () => {
      const next = handshakeReducer({ fidelity: "none", error: "Failed" }, { type: "ready" })
      expect(next.fidelity).toBe("native")
      expect(next.error).toBeUndefined()
    })
  })

  describe("multi-step lifecycle sequences", () => {
    test("full successful native navigation flow", () => {
      let state = INITIAL_HANDSHAKE_STATE
      expect(state.fidelity).toBe("pending")

      state = handshakeReducer(state, { type: "ready" })
      expect(state.fidelity).toBe("native")

      state = handshakeReducer(state, { type: "navigate" })
      expect(state.fidelity).toBe("pending")

      state = handshakeReducer(state, { type: "ready" })
      expect(state.fidelity).toBe("native")
    })

    test("fallback to mirror and subsequent re-navigation", () => {
      let state = INITIAL_HANDSHAKE_STATE

      // Handshake times out -> falls back to mirror
      state = handshakeReducer(state, { type: "timeout" })
      expect(state.fidelity).toBe("mirror")

      // Mirror bridge loads
      state = handshakeReducer(state, { type: "ready" })
      expect(state.fidelity).toBe("mirror")

      // User navigates somewhere else -> resets to pending
      state = handshakeReducer(state, { type: "navigate" })
      expect(state.fidelity).toBe("pending")
    })

    test("failure to none and recovery on navigation", () => {
      let state = INITIAL_HANDSHAKE_STATE

      state = handshakeReducer(state, { type: "load-error", error: "404 Not Found" })
      expect(state.fidelity).toBe("none")
      expect(state.error).toBe("404 Not Found")

      state = handshakeReducer(state, { type: "navigate" })
      expect(state.fidelity).toBe("pending")
      expect(state.error).toBeUndefined()
    })
  })

  describe("reduceFidelity helper", () => {
    test("reduces fidelity directly", () => {
      expect(reduceFidelity("pending", { type: "ready" })).toBe("native")
      expect(reduceFidelity("pending", { type: "timeout" })).toBe("mirror")
      expect(reduceFidelity("pending", { type: "load-error" })).toBe("none")
      expect(reduceFidelity("native", { type: "navigate" })).toBe("pending")
      expect(reduceFidelity("mirror", { type: "navigate" })).toBe("pending")
      expect(reduceFidelity("none", { type: "navigate" })).toBe("pending")
    })
  })
})

describe("no-bridge event", () => {
  test("settles pending on the real page, without inspection", () => {
    expect(handshakeReducer({ fidelity: "pending" }, { type: "no-bridge" })).toEqual({ fidelity: "none", error: undefined })
  })

  test("is a no-op once the handshake has settled", () => {
    expect(reduceFidelity("native", { type: "no-bridge" })).toBe("native")
    expect(reduceFidelity("mirror", { type: "no-bridge" })).toBe("mirror")
    expect(handshakeReducer({ fidelity: "none", error: "404" }, { type: "no-bridge" }).error).toBe("404")
  })
})

describe("framingBlocked", () => {
  const headers = (map: Record<string, string>) => (name: string) => map[name] ?? null

  test("nothing readable is not a block", () => {
    expect(framingBlocked(headers({}))).toBe(false)
  })

  test("X-Frame-Options deny or sameorigin blocks", () => {
    expect(framingBlocked(headers({ "x-frame-options": "DENY" }))).toBe(true)
    expect(framingBlocked(headers({ "x-frame-options": " SameOrigin " }))).toBe(true)
  })

  test("frame-ancestors without * blocks, with * does not", () => {
    expect(framingBlocked(headers({ "content-security-policy": "default-src 'self'; frame-ancestors 'none'" }))).toBe(true)
    expect(framingBlocked(headers({ "content-security-policy": "frame-ancestors https://example.com" }))).toBe(true)
    expect(framingBlocked(headers({ "content-security-policy": "frame-ancestors *" }))).toBe(false)
  })

  test("a policy without frame-ancestors does not block", () => {
    expect(framingBlocked(headers({ "content-security-policy": "default-src 'self'; script-src 'self'" }))).toBe(false)
  })
})

describe("bridgelessChoice", () => {
  test("browsing a page that can be framed keeps it", () => {
    expect(bridgelessChoice({ blocked: false, inspecting: false })).toBe("keep-page")
  })

  test("a page that cannot be framed, or a page being inspected, gets the mirror", () => {
    expect(bridgelessChoice({ blocked: true, inspecting: false })).toBe("mirror")
    expect(bridgelessChoice({ blocked: false, inspecting: true })).toBe("mirror")
  })
})

/*
 * The user's report: a page without the bridge (bastelli-cmp.vercel.app)
 * flipped between the real page ("Connessione...") and an unstyled mirror.
 * Every Reload showed the real page for the 1.5 s handshake window, then the
 * timeout swapped it for the mirror. This replays that sequence the way the
 * pane settles it.
 */
describe("reloading a page without the bridge", () => {
  const settle = (inspecting: boolean) => {
    let fidelity = reduceFidelity("none", { type: "navigate" })
    const shown: string[] = [fidelity]
    const choice = bridgelessChoice({ blocked: false, inspecting })
    fidelity = reduceFidelity(fidelity, { type: choice === "keep-page" ? "no-bridge" : "timeout" })
    if (choice === "mirror") fidelity = reduceFidelity(fidelity, { type: "ready", mode: "mirror" })
    shown.push(fidelity)
    return shown
  }

  test("keeps the real page on every reload and never shows the mirror", () => {
    const history = [1, 2, 3, 4].flatMap(() => settle(false))
    expect(history).not.toContain("mirror")
    expect(history.filter((state, index) => index % 2 === 1)).toEqual(["none", "none", "none", "none"])
  })

  test("uses the mirror only while inspecting", () => {
    expect(settle(true)).toEqual(["pending", "mirror"])
  })
})

describe("noticeWithoutCopy", () => {
  test("a site that refuses framing and copying says so, whatever the mode", () => {
    expect(noticeWithoutCopy({ blocked: true, inspecting: false })).toBe("blocked")
    expect(noticeWithoutCopy({ blocked: true, inspecting: true })).toBe("blocked")
  })

  test("Inspect without a copy explains itself; browsing needs no message", () => {
    expect(noticeWithoutCopy({ blocked: false, inspecting: true })).toBe("no-copy")
    expect(noticeWithoutCopy({ blocked: false, inspecting: false })).toBeUndefined()
  })
})
