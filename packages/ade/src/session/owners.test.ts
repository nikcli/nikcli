import { describe, expect, test } from "bun:test"
import { boardCandidates, matchesPattern, parseOwners, whoOwns } from "./owners"

const board = [
  "## File: chi li possiede",
  "",
  "Toccare un file di un altro solo dopo averglielo chiesto.",
  "",
  "| Proprietario | File |",
  "|---|---|",
  "| **Fabio** | `packages/ade/src/bots/**`, `src/sidebar/sidebar.*`, parti mailbox di `src/surface/workbench.tsx`, `src-tauri/src/mailbox.rs` |",
  "| Voice | `packages/voice/**`, `src-tauri/src/lib.rs` (`open_main_window`), badge TEST in `src/dev.tsx` |",
  "| GitHub | `.github/workflows/ade-*.yml`, `lib.rs` (`ade_update_install`), blocco aggiornamenti di `workbench.tsx`, `tauri.conf.json` (`plugins.updater`) |",
  "",
  "**File condivisi**, da modificare solo nella propria parte:",
  "",
  "- `src/surface/workbench.tsx`: file grande e comune; ognuno tocca solo i propri blocchi.",
  "",
  "## Regole",
].join("\n")

describe("the owners table", () => {
  const table = parseOwners(board)

  test("reads path patterns, not symbols, with the words beside them", () => {
    expect(table.entries.map((entry) => entry.pattern)).not.toContain("open_main_window")
    expect(table.entries.map((entry) => entry.pattern)).not.toContain("plugins.updater")
    expect(table.entries.find((entry) => entry.pattern === "src/surface/workbench.tsx")).toEqual({
      owner: "Fabio",
      pattern: "src/surface/workbench.tsx",
      note: "parti mailbox",
    })
    expect(table.rule).toBe("Toccare un file di un altro solo dopo averglielo chiesto.")
    expect(table.shared).toEqual([
      { pattern: "src/surface/workbench.tsx", rule: "file grande e comune; ognuno tocca solo i propri blocchi." },
    ])
  })

  test("a file with several owners lists each one's part, the shared rule and the board's rule", () => {
    const out = whoOwns(table, "packages/ade/src/surface/workbench.tsx")
    expect(out).toContain("  Fabio: parti mailbox")
    expect(out).toContain("  GitHub: blocco aggiornamenti")
    expect(out).toContain("  condiviso: file grande e comune")
    expect(out).toContain("regola: Toccare un file")
  })

  test("globs, package-relative paths and bare file names all match", () => {
    expect(whoOwns(table, "packages/ade/src/bots/runners.ts")).toContain("Fabio")
    expect(whoOwns(table, "packages\\voice\\src\\engine.ts")).toContain("Voice")
    expect(whoOwns(table, ".github/workflows/ade-release.yml")).toContain("GitHub")
    const lib = whoOwns(table, "packages/ade/src-tauri/src/lib.rs")
    expect(lib).toContain("Voice")
    expect(lib).toContain("GitHub")
  })

  test("an unowned file says so", () => {
    expect(whoOwns(table, "README.md")).toContain("nessun proprietario")
  })
})

test("patterns: one star is one segment, two are any depth", () => {
  expect(matchesPattern("src/sidebar/sidebar.*", "packages/ade/src/sidebar/sidebar.css")).toBe(true)
  expect(matchesPattern("src/*.ts", "src/a/b.ts")).toBe(false)
  expect(matchesPattern("src/**", "src/a/b.ts")).toBe(true)
  expect(matchesPattern("lib.rs", "x/glib.rs")).toBe(false)
})

test("the board is looked for in the project, then beside it", () => {
  expect(boardCandidates("C:\\Users\\me\\Favorites\\nikcli-ade")).toEqual([
    "C:/Users/me/Favorites/nikcli-ade/.ade/TEAM.md",
    "C:/Users/me/Favorites/ade-team/TEAM.md",
  ])
})
