import { describe, expect, test } from "bun:test"
import { parseRequest } from "../panels/protocol"
import { runSimulatorCommand, type SimulatorController } from "./commands"
import {
  clampWindowSize,
  describeSimulator,
  deviceById,
  fitFrame,
  guessDevServers,
  isLoadableAppUrl,
  parseAppUrl,
  parseSize,
  type SimulatorState,
} from "./simulator"

describe("fitFrame", () => {
  const phone = deviceById("iphone-15")

  test("a phone in portrait: viewport is the screen minus its status bar", () => {
    const fit = fitFrame({ device: phone, landscape: false, containerWidth: 2000, containerHeight: 2000 })
    expect(fit.viewportWidth).toBe(393)
    expect(fit.viewportHeight).toBe(852 - 54)
    expect(fit.outerWidth).toBe(393 + 24)
    expect(fit.scale).toBe(1)
  })

  test("rotation swaps the screen and drops the status bar", () => {
    const fit = fitFrame({ device: phone, landscape: true, containerWidth: 2000, containerHeight: 2000 })
    expect(fit.viewportWidth).toBe(852)
    expect(fit.viewportHeight).toBe(393)
    expect(fit.statusBar).toBe(0)
  })

  test("scales down to fit, never up", () => {
    const small = fitFrame({ device: phone, landscape: false, containerWidth: 300, containerHeight: 500, padding: 0 })
    expect(small.scale).toBeCloseTo(Math.min(300 / 417, 500 / 876), 6)
    expect(small.renderedHeight).toBeLessThanOrEqual(500)
    expect(small.renderedWidth).toBeLessThanOrEqual(300)
  })

  test("an unmeasured pane scales to zero rather than to infinity", () => {
    expect(fitFrame({ device: phone, landscape: false, containerWidth: 0, containerHeight: 0 }).scale).toBe(0)
  })

  test("a desktop window uses the dragged size, adds its title bar, and ignores rotation", () => {
    const fit = fitFrame({
      device: deviceById("window"),
      landscape: true,
      windowSize: { width: 900, height: 600 },
      containerWidth: 4000,
      containerHeight: 4000,
    })
    expect([fit.viewportWidth, fit.viewportHeight]).toEqual([900, 600])
    expect(fit.outerHeight).toBe(630)
  })

  test("an unknown device id falls back to the default phone", () => {
    expect(deviceById("nokia-3310").id).toBe("iphone-15")
  })
})

describe("window sizes", () => {
  test("are clamped and rounded", () => {
    expect(clampWindowSize(100.6, 99999)).toEqual({ width: 320, height: 2160 })
    expect(clampWindowSize(Number.NaN, 700.4)).toEqual({ width: 320, height: 700 })
  })

  test("parse the ways people write them", () => {
    expect(parseSize("1280x800")).toEqual({ width: 1280, height: 800 })
    expect(parseSize("1024 × 768")).toEqual({ width: 1024, height: 768 })
    expect(parseSize("grande")).toBeUndefined()
  })
})

describe("guessDevServers", () => {
  test("Tauri's devUrl comes first, then the scripts", () => {
    const guesses = guessDevServers({
      tauriConf: JSON.stringify({ build: { devUrl: "http://localhost:1420/" } }),
      packageJson: JSON.stringify({ scripts: { dev: "vite", build: "vite build" } }),
    })
    expect(guesses).toEqual([
      { label: "Tauri (devUrl)", url: "http://localhost:1420" },
      { label: "Vite", url: "http://localhost:5173", command: "dev" },
    ])
  })

  test("a port in the script beats the tool's default", () => {
    const guesses = guessDevServers({ packageJson: JSON.stringify({ scripts: { dev: "next dev -p 4000" } }) })
    expect(guesses[0]).toEqual({ label: "Next.js", url: "http://localhost:4000", command: "dev" })
  })

  test("an Expo project is recognised from app.json even without a web script", () => {
    const guesses = guessDevServers({
      appJson: JSON.stringify({ expo: { name: "app" } }),
      packageJson: JSON.stringify({ scripts: { start: "expo start" } }),
    })
    expect(guesses).toEqual([{ label: "Expo (web)", url: "http://localhost:8081", command: "start" }])
  })

  test("broken or missing config yields nothing", () => {
    expect(guessDevServers({ packageJson: "{ nope", tauriConf: "null" })).toEqual([])
    expect(guessDevServers({})).toEqual([])
  })

  test("scripts that only build are not dev servers", () => {
    expect(guessDevServers({ packageJson: JSON.stringify({ scripts: { build: "vite build", test: "vitest" } }) })).toEqual([])
  })
})

describe("app URLs", () => {
  test("a bare port, a host and port, or a full URL", () => {
    expect(parseAppUrl("5173")).toBe("http://localhost:5173/")
    expect(parseAppUrl("192.168.1.20:8081/app")).toBe("http://192.168.1.20:8081/app")
    expect(parseAppUrl("https://example.test")).toBe("https://example.test/")
  })

  test("refuses what is not http", () => {
    expect(parseAppUrl("file:///C:/x.html")).toBeUndefined()
    expect(parseAppUrl("javascript:alert(1)")).toBeUndefined()
    expect(parseAppUrl("   ")).toBeUndefined()
  })

  test("ADE's own origin cannot be loaded with same-origin rights", () => {
    expect(isLoadableAppUrl("http://localhost:5177/", "http://localhost:5177")).toBe(false)
    expect(isLoadableAppUrl("http://tauri.localhost/x", "http://tauri.localhost")).toBe(false)
    expect(isLoadableAppUrl("http://localhost:5173/", "http://localhost:5177")).toBe(true)
    expect(isLoadableAppUrl("data:text/html,hi", "http://tauri.localhost")).toBe(false)
  })
})

describe("runSimulatorCommand", () => {
  function fake(reachable = true) {
    let state: SimulatorState = { device: deviceById("iphone-15"), landscape: false, viewportWidth: 393, viewportHeight: 798 }
    const controller: SimulatorController = {
      state: () => state,
      async open(url) {
        state = { ...state, url, reachable }
        return reachable
      },
      setDevice(id) {
        const device = deviceById(id)
        const fit = fitFrame({ device, landscape: state.landscape, containerWidth: 9999, containerHeight: 9999 })
        state = { ...state, device, viewportWidth: fit.viewportWidth, viewportHeight: fit.viewportHeight }
      },
      rotate() {
        state = { ...state, landscape: !state.landscape }
      },
      setWindowSize(size) {
        state = { ...state, viewportWidth: size.width, viewportHeight: size.height }
      },
      async reload() {
        return reachable
      },
    }
    return controller
  }
  const request = (line: string) => parseRequest(line)!

  test("open reports what is shown, and fails when no server answers", async () => {
    expect(await runSimulatorCommand(fake(), request("@ade app open 5173"))).toEqual({
      ok: true,
      detail: "http://localhost:5173/ su iPhone 15 (393×798, verticale)",
    })
    const down = await runSimulatorCommand(fake(false), request("@ade app open 5173"))
    expect(down).toEqual({ ok: false, reason: "http://localhost:5173/ su iPhone 15 (393×798, verticale) — server non raggiungibile" })
  })

  test("size is for windows only, rotate for devices only", async () => {
    const controller = fake()
    expect((await runSimulatorCommand(controller, request("@ade app size 800x600"))).ok).toBe(false)
    await runSimulatorCommand(controller, request("@ade app device window"))
    expect((await runSimulatorCommand(controller, request("@ade app rotate"))).ok).toBe(false)
    expect(await runSimulatorCommand(controller, request("@ade app size 800x600"))).toEqual({
      ok: true,
      detail: "nessuna app aperta su Finestra desktop (800×600)",
    })
  })

  test("an unknown device lists the known ones", async () => {
    const outcome = await runSimulatorCommand(fake(), request("@ade app device nokia"))
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.reason).toContain("iphone-15")
  })

  test("describes landscape", () => {
    expect(describeSimulator({ device: deviceById("pixel-8"), landscape: true, viewportWidth: 915, viewportHeight: 412, url: "http://x/" })).toBe(
      "http://x/ su Pixel 8 (915×412, orizzontale)",
    )
  })
})
