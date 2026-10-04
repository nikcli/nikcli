import { describe, expect, test } from "bun:test"
import path from "path"
import { testRender } from "@opentui/solid"
import type { CapturedFrame } from "@opentui/core"

/**
 * The gadgets sidebar block, painted by OpenTUI's real Solid renderer.
 *
 * It is TSX from outside this package, so what matters is that it compiles
 * under the host's transform and that what it paints is what a user would read:
 * nothing before a gadget is paired, then one row per device with its state.
 */
const pluginDir = path.resolve(import.meta.dir, "../../../gadget-plugin")
const { Gadgets } = await import(path.join(pluginDir, "src", "sidebar.tsx"))

function painted(captureSpans: () => CapturedFrame): string {
  return captureSpans()
    .lines.map((line) =>
      line.spans
        .map((span) => span.text)
        .join("")
        .replace(/\s+$/, ""),
    )
    .filter((line) => line.trim().length > 0)
    .join("\n")
}

function device(overrides: Record<string, unknown>) {
  return {
    id: "x",
    name: "x",
    online: false,
    confirmed: true,
    platform: { os: "linux", arch: "arm64" },
    commands: [],
    createdAt: 1,
    ...overrides,
  }
}

function bridge(devices: unknown[], calls: string[] = []) {
  return Object.assign(
    async (input: RequestInfo | URL) => {
      calls.push(String(input))
      return new Response(JSON.stringify(devices), { status: 200 })
    },
    { preconnect: () => undefined },
  ) as typeof globalThis.fetch
}

async function until(check: () => boolean, ms = 2_000) {
  const started = Date.now()
  while (!check()) {
    if (Date.now() - started > ms) throw new Error("condition not reached in time")
    await Bun.sleep(10)
  }
}

describe("gadgets sidebar", () => {
  test("paints nothing until a gadget is paired", async () => {
    const calls: string[] = []
    const { captureSpans, renderOnce } = await testRender(
      () => (
        <box width={30} height={6}>
          <Gadgets url="http://127.0.0.1:4097" fetcher={bridge([], calls)} intervalMs={60_000} />
        </box>
      ),
      { width: 30, height: 6 },
    )
    await until(() => calls.length > 0)
    await renderOnce()
    expect(painted(captureSpans)).toBe("")
    expect(calls[0]).toBe("http://127.0.0.1:4097/admin/devices")
  })

  test("lists each gadget with its state and counts the online ones", async () => {
    const calls: string[] = []
    const fetcher = bridge(
      [
        device({ id: "pi-office", online: true }),
        device({ id: "desk-badge", online: false }),
        device({ id: "new-board", confirmed: false }),
      ],
      calls,
    )
    const { captureSpans, renderOnce } = await testRender(
      () => (
        <box width={34} height={8}>
          <Gadgets url="http://127.0.0.1:4097" fetcher={fetcher} intervalMs={60_000} />
        </box>
      ),
      { width: 34, height: 8 },
    )
    await until(() => calls.length > 0)
    await Bun.sleep(30)
    await renderOnce()
    const text = painted(captureSpans)
    expect(text).toContain("Gadgets (1 online)")
    expect(text).toContain("pi-office online")
    expect(text).toContain("desk-badge offline")
    expect(text).toContain("new-board press button")
  })

  test("shows nothing, not an error, when the bridge is unreachable", async () => {
    const down = Object.assign(
      async () => {
        throw new Error("connection refused")
      },
      { preconnect: () => undefined },
    ) as typeof globalThis.fetch
    const { captureSpans, renderOnce } = await testRender(
      () => (
        <box width={30} height={6}>
          <Gadgets url="http://127.0.0.1:1" fetcher={down} intervalMs={60_000} />
        </box>
      ),
      { width: 30, height: 6 },
    )
    await Bun.sleep(30)
    await renderOnce()
    expect(painted(captureSpans)).toBe("")
  })
})
