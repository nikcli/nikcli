import { describe, expect, it } from "bun:test"
import { Sandbox } from "@/sandbox"

/**
 * EOT-17 sandbox contract.
 *
 * `specs/effect-tui/17-sandbox-permission-boundaries.md` requires:
 *  - `scrubEnv()` strips credentials before passing env to a child process.
 *  - `assertContained()` refuses a cwd that escapes the project directory.
 *  - Errors are typed (`EscapeError` / `TimeoutError` / `FailedError`),
 *    never a bare `throw new Error`.
 *
 * These are pure unit tests where possible — they exercise the scrubber
 * and the EscapeError shape without forking a real process. Spawning a
 * process happens through the Effect service, which needs a runtime;
 * that path is covered by the integration test suite elsewhere.
 */

describe("EOT-17 Sandbox contract", () => {
  it("SAFE_ENV_PASSTHROUGH is the canonical allowlist (no more, no less)", () => {
    expect(Sandbox.SAFE_ENV_PASSTHROUGH).toEqual(["PATH", "HOME", "LANG", "LC_ALL", "TERM", "USER", "TMPDIR", "SHELL"])
  })

  it("scrubEnv returns only the allowlist from process.env", () => {
    const previous = { ...process.env }
    try {
      process.env.PATH = "/bin"
      process.env.HOME = "/home/test"
      process.env.NIKCLI_AUTH_TOKEN = "secret-do-not-leak"
      process.env.AWS_SECRET_ACCESS_KEY = "aws-secret"
      delete process.env.LANG
      delete process.env.LC_ALL
      delete process.env.TERM
      delete process.env.USER
      delete process.env.TMPDIR
      delete process.env.SHELL

      const scrubbed = Sandbox.scrubEnv()
      expect(scrubbed.PATH).toBe("/bin")
      expect(scrubbed.HOME).toBe("/home/test")
      expect(scrubbed).not.toHaveProperty("NIKCLI_AUTH_TOKEN")
      expect(scrubbed).not.toHaveProperty("AWS_SECRET_ACCESS_KEY")
    } finally {
      process.env = previous
    }
  })

  it("scrubEnv preserves caller-supplied extras on top of the allowlist", () => {
    const previous = { ...process.env }
    try {
      process.env.PATH = "/bin"
      const scrubbed = Sandbox.scrubEnv({ CUSTOM_VAR: "value", ANOTHER: "ok" })
      expect(scrubbed.PATH).toBe("/bin")
      expect(scrubbed.CUSTOM_VAR).toBe("value")
      expect(scrubbed.ANOTHER).toBe("ok")
    } finally {
      process.env = previous
    }
  })

  it("scrubEnv omits allowlist keys whose process.env value is undefined", () => {
    const previous = { ...process.env }
    try {
      for (const key of Sandbox.SAFE_ENV_PASSTHROUGH) delete process.env[key]
      const scrubbed = Sandbox.scrubEnv()
      for (const key of Sandbox.SAFE_ENV_PASSTHROUGH) {
        expect(scrubbed).not.toHaveProperty(key)
      }
    } finally {
      process.env = previous
    }
  })

  it("EscapeError is a tagged error with cwd + project + a populated message", () => {
    const error = new Sandbox.EscapeError({
      cwd: "/etc/passwd",
      project: "/home/nikcli",
    })
    expect(error._tag).toBe("SandboxEscapeError")
    expect(error.cwd).toBe("/etc/passwd")
    expect(error.project).toBe("/home/nikcli")
    expect(error.message).toContain("/etc/passwd")
    expect(error.message).toContain("/home/nikcli")
    expect(error.message).toContain("escapes")
  })

  it("TimeoutError carries timeoutMs + command and a populated message", () => {
    const error = new Sandbox.TimeoutError({
      timeoutMs: 30_000,
      command: "sleep 999",
    })
    expect(error._tag).toBe("SandboxTimeoutError")
    expect(error.timeoutMs).toBe(30_000)
    expect(error.command).toBe("sleep 999")
    expect(error.message).toContain("30000")
    expect(error.message).toContain("sleep 999")
  })

  it("FailedError carries exitCode + command + truncated stderr and a populated message", () => {
    const stderr = "x".repeat(1_500)
    const error = new Sandbox.FailedError({
      exitCode: 2,
      command: "false",
      stderr,
    })
    expect(error._tag).toBe("SandboxFailedError")
    expect(error.exitCode).toBe(2)
    expect(error.message).toContain("false")
    expect(error.stderr.length).toBe(1_500)
  })

  it("defaultLayer is localLayer today (no Vercel/Docker/Firecracker layer is wired)", () => {
    // The plug-in points documented in `Sandbox.index.ts` exist as types but
    // not as Layer implementations. Today `defaultLayer === localLayer`.
    expect(Sandbox.defaultLayer).toBe(Sandbox.localLayer)
  })

  it("Service is the canonical Context tag other layers should satisfy", () => {
    expect(Sandbox.Service.key).toBe("Sandbox.Service")
  })
})

describe("EOT-17 Sandbox.Error union", () => {
  it("is the union of EscapeError | TimeoutError | FailedError", () => {
    const escape = new Sandbox.EscapeError({ cwd: "/a", project: "/b" })
    const timeout = new Sandbox.TimeoutError({ timeoutMs: 1, command: "x" })
    const failed = new Sandbox.FailedError({
      exitCode: 1,
      command: "x",
      stderr: "x",
    })
    const all: Sandbox.Error[] = [escape, timeout, failed]
    expect(all.every((e) => e instanceof Error)).toBe(true)
  })
})
