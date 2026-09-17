import { describe, expect, test } from "bun:test"
import domino from "@mixmark-io/domino"

// Integration checks against the production output: run `bun run build` first.
const dist = new URL("../dist/", import.meta.url)
const pages = ["docs/index.html", "docs/tools/index.html", "docs/brand/index.html"]

async function document(path: string) {
  return domino.createDocument(await Bun.file(new URL(path, dist)).text())
}

describe("social sharing metadata", () => {
  test("renders page-specific Open Graph and Twitter metadata without JavaScript", async () => {
    for (const path of pages) {
      const doc = await document(path)
      const meta = (selector: string) => doc.querySelector(selector)?.getAttribute("content")
      expect(meta('meta[property="og:title"]')).toBe(doc.title)
      expect(meta('meta[name="twitter:title"]')).toBe(doc.title)
      expect(meta('meta[property="og:description"]')).toBe(meta('meta[name="description"]'))
      expect(meta('meta[property="og:site_name"]')).toBe("nikcli")
      expect(meta('meta[name="twitter:card"]')).toBe("summary_large_image")
      expect(doc.querySelectorAll('meta[property="og:image"]').length).toBe(1)
      expect(meta('meta[property="og:image"]')).toBe("https://nikcli.store/og.png")
      expect(meta('meta[name="twitter:image"]')).toBe(meta('meta[property="og:image"]'))
      expect(meta('meta[property="og:image:alt"]')).toBeTruthy()
      expect(meta('meta[property="og:image:width"]')).toBe("1200")
      expect(meta('meta[property="og:image:height"]')).toBe("630")
    }
  })

  test("canonical and OG URLs use the production origin and current page", async () => {
    for (const path of pages) {
      const doc = await document(path)
      const canonical = doc.querySelector('link[rel="canonical"]')!.getAttribute("href")!
      expect(doc.querySelectorAll('link[rel="canonical"]').length).toBe(1)
      const url = new URL(canonical)
      expect(url.origin).toBe("https://nikcli.store")
      expect(url.pathname.replace(/\/$/, "")).toBe(`/${path.replace(/\/index.html$/, "")}`)
      expect(url.search).toBe("")
      expect(url.hash).toBe("")
      expect(doc.querySelector('meta[property="og:url"]')?.getAttribute("content")).toBe(canonical)
    }
  })

  test("all declared icons exist in the deployment output", async () => {
    const doc = await document(pages[0])
    const icons = doc.querySelectorAll('link[rel="icon"], link[rel="apple-touch-icon"]')
    expect(icons.length).toBe(3)
    for (const icon of Array.from(icons)) {
      const path = icon.getAttribute("href")!
      expect(await Bun.file(new URL(path.slice(1), dist)).exists()).toBe(true)
    }
  })

  test("social image and touch icon are PNGs with the advertised dimensions", async () => {
    for (const [path, width, height] of [
      ["og.png", 1200, 630],
      ["og-light.png", 1200, 630],
      ["apple-touch-icon.png", 180, 180],
      ["apple-touch-icon-light.png", 180, 180],
    ] as const) {
      const bytes = Buffer.from(await Bun.file(new URL(path, dist)).arrayBuffer())
      expect(bytes.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a")
      expect(bytes.readUInt32BE(16)).toBe(width)
      expect(bytes.readUInt32BE(20)).toBe(height)
      expect(bytes.byteLength).toBeLessThan(1024 * 1024)
    }
  })
})
