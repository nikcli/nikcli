import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { AGENTS } from "./agents"

/**
 * The catalogue the form offers, against the allowlist that decides what may
 * actually start.
 *
 * Two lists, in two languages, that have to agree: `AGENTS[].command` here
 * and `ALLOWED_AGENTS` in `src-tauri/src/pty.rs`. Both files say "keep in
 * step with the other" in a comment, and a comment is not a check — an agent
 * added to the form and not to the allowlist is offered, selected, started,
 * and refused by Rust with "comando non consentito", which reads as a broken
 * install rather than as a missing line.
 *
 * So the test reads the Rust file rather than restating its contents. A
 * second copy of the list in TypeScript would be a third thing to keep in
 * step, and would pass while the real allowlist was wrong.
 */

const PTY_RS = new URL("../../src-tauri/src/pty.rs", import.meta.url)

/** Pulls the string literals out of a `const NAME: &[&str] = &[…];`. */
function rustStringList(source: string, name: string): string[] {
  const declaration = new RegExp(`const ${name}: &\\[&str\\] = &\\[([^\\]]*)\\]`, "g")
  const found: string[] = []
  for (let match = declaration.exec(source); match !== null; match = declaration.exec(source)) {
    for (const quoted of match[1]!.matchAll(/"([^"]+)"/g)) found.push(quoted[1]!)
  }
  return found
}

const source = readFileSync(PTY_RS, "utf8")
const allowedAgents = rustStringList(source, "ALLOWED_AGENTS")
// Two declarations, one per platform, behind `#[cfg]`. Both are checked,
// because the form is the same on both and a shell missing from one platform
// is a Terminal pane that never starts there.
const allowedShells = rustStringList(source, "ALLOWED_SHELLS")

describe("the agent catalogue and the Rust allowlist", () => {
  test("the allowlist was actually found, so a rename cannot make this test vacuous", () => {
    expect(allowedAgents.length).toBeGreaterThan(5)
    expect(allowedShells.length).toBeGreaterThan(3)
  })

  test("every agent the form offers may be started", () => {
    const allowed = new Set([...allowedAgents, ...allowedShells].map((name) => name.toLowerCase()))
    for (const agent of AGENTS) {
      // `terminal` carries whichever shell this platform uses; both spellings
      // are in the shell list, so either passes.
      expect([agent.id, agent.command, allowed.has(agent.command.toLowerCase())]).toEqual([
        agent.id,
        agent.command,
        true,
      ])
    }
  })

  test("the shells the form can choose are on the list for both platforms", () => {
    // `systemShell()` answers "cmd" on Windows, "zsh" on macOS and "sh"
    // elsewhere, and the test process runs on one of them — so all are asserted
    // by name rather than by calling it.
    const allowed = new Set(allowedShells.map((name) => name.toLowerCase()))
    expect(allowed.has("cmd")).toBe(true)
    expect(allowed.has("zsh")).toBe(true)
    expect(allowed.has("sh")).toBe(true)
  })

  test("the event topic the host listens on is the one Rust emits", () => {
    /*
     * `host/shell.ts` builds `pty:data:${id}` and `pty.rs` builds it with
     * `format!`. A mismatch is a pane that draws nothing at all, with no
     * error anywhere: the listener is simply never called.
     */
    expect(source).toContain(`format!("pty:data:{id}")`)
  })

  test("nothing is on the allowlist that the form cannot offer", () => {
    /*
     * The other direction, and the reason it is worth checking: an entry that
     * no longer has an agent behind it is a name ADE will still start if
     * anything asks it to — and the browser pane is something that asks.
     */
    const offered = new Set(AGENTS.map((agent) => agent.command.toLowerCase()))
    const orphans = allowedAgents.filter((name) => !offered.has(name.toLowerCase()))
    expect(orphans).toEqual([])
  })
})
