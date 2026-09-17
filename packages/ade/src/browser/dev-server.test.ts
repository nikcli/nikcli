import { describe, expect, test } from "bun:test"
import { devServerUrl, offerKey, serverOf, shouldOffer } from "./dev-server"

describe("devServerUrl", () => {
  test("the lines the usual dev servers print", () => {
    const cases: [string, string][] = [
      ["  ➜  Local:   http://localhost:5173/", "http://localhost:5173/"],
      ["   - Local:        http://localhost:3000", "http://localhost:3000/"],
      ["ready - started server on 0.0.0.0:3000, url: http://localhost:3000", "http://localhost:3000/"],
      ["  Local    http://localhost:4321/", "http://localhost:4321/"],
      ["Starting development server at http://127.0.0.1:8000/", "http://localhost:8000/"],
      ["Started development server: http://localhost:3000", "http://localhost:3000/"],
      ["Server running at http://[::1]:8080/app/", "http://localhost:8080/app/"],
      ["Listening on port 8787", "http://localhost:8787/"],
      ["server listening on :4000", "http://localhost:4000/"],
      ["  > Local: https://localhost:5173/base.", "https://localhost:5173/base"],
    ]
    for (const [line, url] of cases) expect([line, devServerUrl(line)]).toEqual([line, url])
  })

  test("through colours, links and a TUI's frame", () => {
    expect(devServerUrl("[32m  ➜[39m  [1mLocal[22m:   [36mhttp://localhost:[1m5173[22m/[39m")).toBe(
      "http://localhost:5173/",
    )
    expect(devServerUrl("│ ⎿  VITE v6 ready in 300 ms  Local: http://localhost:5174/ │")).toBe("http://localhost:5174/")
  })

  test("not an announcement", () => {
    for (const line of [
      "  ➜  Network: http://192.168.1.4:5173/",
      "  ➜  Network: use --host to expose",
      "fetching http://localhost:3000/api/users",
      "see https://example.com/docs, the dev server docs",
      "Local: http://localhost/",
      "listening on port 12",
      "",
      "x".repeat(500) + " Local: http://localhost:3000",
    ]) {
      expect([line.slice(0, 40), devServerUrl(line)]).toEqual([line.slice(0, 40), undefined])
    }
  })
})

describe("offers", () => {
  test("the same server has one key, whatever the address", () => {
    expect(serverOf("http://127.0.0.1:5173/a")).toBe("http://localhost:5173")
    expect(offerKey("n1", "http://localhost:5173/")).toBe(offerKey("n1", "http://0.0.0.0:5173/x"))
    expect(offerKey("n1", "not a url")).toBe("")
  })

  test("once per session and server, and not over the session's own pane", () => {
    const seen = new Set([offerKey("n1", "http://localhost:5173/")])
    expect(shouldOffer({ sessionId: "n1", url: "http://localhost:5173/", seen })).toBe(false)
    expect(shouldOffer({ sessionId: "n2", url: "http://localhost:5173/", seen })).toBe(true)
    expect(shouldOffer({ sessionId: "n1", url: "http://localhost:3000/", seen })).toBe(true)
    expect(
      shouldOffer({ sessionId: "n1", url: "http://localhost:3000/", seen, ownedUrl: "http://127.0.0.1:3000/settings" }),
    ).toBe(false)
    expect(shouldOffer({ sessionId: "n1", url: "http://localhost:3000/", seen, ownedUrl: "http://localhost:4000/" })).toBe(true)
  })
})
