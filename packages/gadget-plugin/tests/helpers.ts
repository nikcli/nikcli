import { mkdtempSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import type { Frame, Hello } from "@nikcli-ai/gadget/protocol"
import { Registry, type Feed } from "../src/registry.ts"

export const FINGERPRINT = "fp-0123456789abcdef"

export class FakeFeed implements Feed {
  readonly frames: Frame[] = []
  closed: string | undefined
  full = false
  send(frame: Frame): boolean {
    if (this.full) return false
    this.frames.push(frame)
    return true
  }
  close(reason: string) {
    this.closed = reason
  }
  /** The invoke frames, in order. */
  invokes() {
    return this.frames.filter((frame): frame is Extract<Frame, { type: "invoke" }> => frame.type === "invoke")
  }
}

export function hello(overrides: Partial<Hello> = {}): Hello {
  return {
    protocol: 1,
    name: "pi office",
    version: "1.0.0",
    platform: { os: "linux", arch: "arm64", machine: FINGERPRINT },
    commands: [
      { name: "device.health", description: "health", args: { type: "object" } },
      { name: "system.run", description: "run", args: { type: "object" }, timeoutMs: 5_000 },
      { name: "echo.say", description: "say", args: { type: "object" }, maxOutputBytes: 8 },
    ],
    ...overrides,
  }
}

export interface Paired {
  readonly registry: Registry
  readonly id: string
  readonly token: string
  readonly feed: FakeFeed
}

/** A registry with one paired, hello'd, online device. */
export function online(options: { now?: () => number; file?: string; display?: boolean } = {}): Paired {
  const registry = new Registry({ now: options.now, file: options.file })
  const { code } = registry.openPairing()
  const { id, token } = registry.pair({
    code,
    name: "pi office",
    platform: { os: "linux", arch: "arm64", machine: FINGERPRINT },
    fingerprint: FINGERPRINT,
    button: false,
  })
  registry.hello(id, hello(options.display ? { display: { columns: 20, rows: 4, depth: 1, format: "tree" } } : {}))
  const feed = new FakeFeed()
  registry.attach(id, feed)
  return { registry, id, token, feed }
}

export function tempDir(prefix = "nikcli-gadget-plugin-"): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix))
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

export async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise
  } catch (error) {
    return error
  }
  throw new Error("expected the promise to reject")
}

export function throws(fn: () => unknown): unknown {
  try {
    fn()
  } catch (error) {
    return error
  }
  throw new Error("expected the call to throw")
}

export async function until(check: () => boolean, ms = 3_000): Promise<void> {
  const started = Date.now()
  while (!check()) {
    if (Date.now() - started > ms) throw new Error("condition not reached in time")
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}
