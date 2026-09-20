import { describe, expect, it } from "bun:test"
import { isHeadless, isReplExit, isReplHelp, resolvePermissionPrompt } from "@/cli/headless"

/**
 * The headless posture for the non-TUI CLI.
 *
 * `src/cli/headless.ts` arrived as an extraction out of `cli/handlers/run.ts`
 * and was finished on 2026-09-21. Two of its exports — `isReplExit` and
 * `isReplHelp` — have no consumer, because the REPL they are for does not
 * exist: there is no `nikcli cli` command. They are not wired here either,
 * since inventing a consumer to justify a helper is the wrong direction.
 *
 * What they get instead is the treatment every other awaiting-a-caller
 * contract in this repo has: a test, so the helper cannot rot while it waits.
 * The alternative — untested code with no call site — is the state this whole
 * audit exists to find.
 *
 * `isHeadless` is EOT-18's open `NIKCLI_HEADLESS` requirement, and the posture
 * it decides is fail-closed: a permission prompt with no TTY must never pick
 * "yes".
 */
describe("isHeadless", () => {
  it("lets NIKCLI_HEADLESS win over everything", () => {
    expect(isHeadless({ env: { NIKCLI_HEADLESS: "1" }, stdinIsTTY: true })).toBe(true)
    expect(isHeadless({ env: { NIKCLI_HEADLESS: "true" }, stdinIsTTY: true })).toBe(true)
    // Case-insensitive, because an env var set by a CI system is not typed by
    // the person who read the docs.
    expect(isHeadless({ env: { NIKCLI_HEADLESS: "TRUE" }, stdinIsTTY: true })).toBe(true)
  })

  it("treats a non-TTY stdin as headless", () => {
    expect(isHeadless({ env: {}, stdinIsTTY: false })).toBe(true)
    expect(isHeadless({ env: {}, stdinIsTTY: true })).toBe(false)
  })

  it("exempts the managed PTY the mobile companion runs behind", () => {
    // `NIKCLI_TERMINAL=1` is the signal that stdin is a real terminal the host
    // is driving. Same exception the TUI default command makes; without it,
    // every mobile-driven session would fail closed on its first permission.
    expect(isHeadless({ env: { NIKCLI_TERMINAL: "1" }, stdinIsTTY: false })).toBe(false)
  })

  it("lets an explicit NIKCLI_HEADLESS beat the PTY exemption", () => {
    // The order matters: the explicit flag is checked first, so a caller can
    // force headless even inside a managed terminal.
    expect(isHeadless({ env: { NIKCLI_HEADLESS: "1", NIKCLI_TERMINAL: "1" }, stdinIsTTY: true })).toBe(true)
  })
})

describe("resolvePermissionPrompt", () => {
  it("fails closed when headless, without touching the terminal", async () => {
    // The whole point of the posture: no TTY means "reject", never "once".
    const answer = await resolvePermissionPrompt({
      permission: "bash",
      patterns: ["rm -rf /"],
      always: ["bash"],
      headless: true,
      autoApprove: false,
    })

    expect(answer).toBe("reject")
  })

  it("approves without a TTY only when the caller opted in", async () => {
    // `--auto` is the single documented way through, and it is checked before
    // the headless branch so it works in CI.
    const answer = await resolvePermissionPrompt({
      permission: "bash",
      patterns: ["ls"],
      always: ["bash"],
      headless: true,
      autoApprove: true,
    })

    expect(answer).toBe("once")
  })
})

describe("repl line predicates", () => {
  it("recognises every documented way out", () => {
    for (const line of ["/exit", "/quit", "exit", "quit", "  EXIT  ", "/Quit"]) {
      expect(isReplExit(line)).toBe(true)
    }
  })

  it("does not treat a message that merely mentions them as a command", () => {
    // The predicate trims and lowercases the whole line, so anything with
    // content around the word is a prompt, not an exit.
    for (const line of ["exit the loop", "how do I quit", "/exit please", ""]) {
      expect(isReplExit(line)).toBe(false)
    }
  })

  it("recognises help and nothing near it", () => {
    expect(isReplHelp("/help")).toBe(true)
    expect(isReplHelp("  /HELP ")).toBe(true)
    expect(isReplHelp("help")).toBe(false)
    expect(isReplHelp("/help me")).toBe(false)
  })
})
