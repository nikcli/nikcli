import { describe, expect, test } from "bun:test"
import { DEVICE_PRESETS, fitViewport } from "./viewport"

describe("DEVICE_PRESETS", () => {
  test("defines standard preset dimensions", () => {
    expect(DEVICE_PRESETS.responsive.width).toBe(0)
    expect(DEVICE_PRESETS.responsive.height).toBe(0)

    expect(DEVICE_PRESETS.desktop.width).toBe(1280)
    expect(DEVICE_PRESETS.desktop.height).toBe(800)

    expect(DEVICE_PRESETS.tablet.width).toBe(768)
    expect(DEVICE_PRESETS.tablet.height).toBe(1024)

    expect(DEVICE_PRESETS.mobile.width).toBe(375)
    expect(DEVICE_PRESETS.mobile.height).toBe(812)
  })
})

describe("fitViewport", () => {
  describe("responsive preset", () => {
    test("fills available container box at 100% scale", () => {
      const fit = fitViewport({
        preset: "responsive",
        containerWidth: 1000,
        containerHeight: 600,
      })
      expect(fit.scale).toBe(1)
      expect(fit.viewportWidth).toBe(1000)
      expect(fit.viewportHeight).toBe(600)
      expect(fit.renderedWidth).toBe(1000)
      expect(fit.renderedHeight).toBe(600)
      expect(fit.isResponsive).toBe(true)
    })
  })

  describe("fixed presets and scale capping", () => {
    test("desktop fits 1:1 in exact container", () => {
      const fit = fitViewport({
        preset: "desktop",
        containerWidth: 1280,
        containerHeight: 800,
      })
      expect(fit.scale).toBe(1)
      expect(fit.viewportWidth).toBe(1280)
      expect(fit.viewportHeight).toBe(800)
      expect(fit.renderedWidth).toBe(1280)
      expect(fit.renderedHeight).toBe(800)
    })

    test("never scales above 1 in oversized container", () => {
      const fit = fitViewport({
        preset: "desktop",
        containerWidth: 2560,
        containerHeight: 1600,
      })
      expect(fit.scale).toBe(1)
      expect(fit.renderedWidth).toBe(1280)
      expect(fit.renderedHeight).toBe(800)
    })

    test("scales down uniformly when width constrained", () => {
      const fit = fitViewport({
        preset: "desktop",
        containerWidth: 640,
        containerHeight: 800,
      })
      expect(fit.scale).toBe(0.5)
      expect(fit.viewportWidth).toBe(1280)
      expect(fit.viewportHeight).toBe(800)
      expect(fit.renderedWidth).toBe(640)
      expect(fit.renderedHeight).toBe(400)
    })

    test("scales down uniformly when height constrained", () => {
      const fit = fitViewport({
        preset: "desktop",
        containerWidth: 1280,
        containerHeight: 400,
      })
      expect(fit.scale).toBe(0.5)
      expect(fit.renderedWidth).toBe(640)
      expect(fit.renderedHeight).toBe(400)
    })
  })

  describe("tablet and mobile presets with rotation", () => {
    test("tablet portrait and landscape", () => {
      const portrait = fitViewport({
        preset: "tablet",
        containerWidth: 1000,
        containerHeight: 1200,
        landscape: false,
      })
      expect(portrait.viewportWidth).toBe(768)
      expect(portrait.viewportHeight).toBe(1024)
      expect(portrait.scale).toBe(1)

      const landscape = fitViewport({
        preset: "tablet",
        containerWidth: 1200,
        containerHeight: 900,
        landscape: true,
      })
      expect(landscape.viewportWidth).toBe(1024)
      expect(landscape.viewportHeight).toBe(768)
      expect(landscape.scale).toBe(1)
    })

    test("mobile portrait and landscape scaling", () => {
      const portrait = fitViewport({
        preset: "mobile",
        containerWidth: 375,
        containerHeight: 406,
        landscape: false,
      })
      expect(portrait.viewportWidth).toBe(375)
      expect(portrait.viewportHeight).toBe(812)
      expect(portrait.scale).toBe(0.5)
      expect(portrait.renderedWidth).toBe(188)
      expect(portrait.renderedHeight).toBe(406)

      const landscape = fitViewport({
        preset: "mobile",
        containerWidth: 406,
        containerHeight: 375,
        landscape: true,
      })
      expect(landscape.viewportWidth).toBe(812)
      expect(landscape.viewportHeight).toBe(375)
      expect(landscape.scale).toBe(0.5)
      expect(landscape.renderedWidth).toBe(406)
      expect(landscape.renderedHeight).toBe(188)
    })
  })

  describe("zero and negative boundary handling", () => {
    test("handles zero container dimensions", () => {
      const fit = fitViewport({
        preset: "desktop",
        containerWidth: 0,
        containerHeight: 600,
      })
      expect(fit.scale).toBe(0)
      expect(fit.renderedWidth).toBe(0)
      expect(fit.renderedHeight).toBe(0)
    })

    test("handles negative container dimensions without throwing", () => {
      const fit = fitViewport({
        preset: "mobile",
        containerWidth: -100,
        containerHeight: -200,
      })
      expect(fit.scale).toBe(0)
      expect(fit.renderedWidth).toBe(0)
      expect(fit.renderedHeight).toBe(0)
    })

    test("verifies scale is always <= 1 across varied container sizes", () => {
      for (const preset of ["desktop", "tablet", "mobile"] as const) {
        for (let w = 100; w <= 3000; w += 300) {
          for (let h = 100; h <= 2000; h += 200) {
            const fit = fitViewport({ preset, containerWidth: w, containerHeight: h })
            expect(fit.scale).toBeLessThanOrEqual(1)
            expect(fit.scale).toBeGreaterThanOrEqual(0)
            expect(fit.renderedWidth).toBeLessThanOrEqual(w + 1)
            expect(fit.renderedHeight).toBeLessThanOrEqual(h + 1)
          }
        }
      }
    })
  })
})
