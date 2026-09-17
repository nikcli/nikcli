import { describe, expect, test } from "bun:test"
import { INTRO_TEXT, displayArgs, introArgs, withIntro } from "./intro"

describe("introArgs", () => {
  test("the CLIs with an instructions flag get the notice there", () => {
    expect(introArgs("claude-code")).toEqual(["--append-system-prompt", INTRO_TEXT])
    expect(introArgs("pi")[0]).toBe("--append-system-prompt")
    expect(introArgs("prime")[0]).toBe("--append-system-prompt")
    const codex = introArgs("codex")
    expect(codex[0]).toBe("-c")
    expect(codex[1]!.startsWith('developer_instructions="Sei una sessione')).toBe(true)
  })

  test("the rest get no arguments", () => {
    for (const id of ["agy", "opencode", "nikcli", "kimi", "hermes", "terminal"]) {
      expect([id, introArgs(id)]).toEqual([id, []])
    }
  })

  test("the text survives cmd.exe: none of its metacharacters", () => {
    expect(INTRO_TEXT).not.toMatch(/["&|<>^%]/)
    expect(INTRO_TEXT).toContain("ade-msg send")
  })
})

describe("withIntro", () => {
  test("a CLI without the flag gets it in front of its task", () => {
    expect(withIntro("agy", "sistema il bug", "NOTA")).toBe("(NOTA) sistema il bug")
  })

  test("no task, no notice typed; a CLI with the flag, the task untouched", () => {
    expect(withIntro("agy", "  ", "NOTA")).toBe("  ")
    expect(withIntro("claude-code", "sistema il bug", "NOTA")).toBe("sistema il bug")
  })
})

test("the transcript shows a mark instead of the whole notice", () => {
  expect(displayArgs(["--append-system-prompt", INTRO_TEXT, "--resume", "x"])).toEqual([
    "--append-system-prompt",
    "…ade-msg…",
    "--resume",
    "x",
  ])
  expect(displayArgs(introArgs("codex"))[1]).toBe("developer_instructions=…ade-msg…")
})
