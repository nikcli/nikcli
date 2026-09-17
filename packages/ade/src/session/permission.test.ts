import { describe, expect, test } from "bun:test"
import { detectPermission, isResolved, type PermissionRequest } from "./permission"

describe("detectPermission - Numbered Choices", () => {
  test("detects standard 3-choice permission prompt", () => {
    const lines = ["Do you want to run this command?", "  1. Yes", "  2. Yes, and don't ask again", "  3. No"]
    const req = detectPermission(lines, "test-agent")
    expect(req).toBeDefined()
    expect(req!.what).toBe("Do you want to run this command?")
    expect(req!.answers.length).toBe(3)

    expect(req!.answers[0]).toEqual({
      label: "Sì",
      send: "1",
      tone: "primary",
    })
    expect(req!.answers[1]).toEqual({
      label: "Sì, e non chiedere più",
      send: "2",
      tone: "secondary",
    })
    expect(req!.answers[2]).toEqual({
      label: "No",
      send: "3",
      tone: "secondary",
    })
  })

  test("detects shell command context with numbered choices and trailing prompt", () => {
    const lines = [
      "$ rm -rf dist/",
      "Execute this command?",
      "  1) Allow once",
      "  2) Allow always",
      "  3) Deny",
      "Select an option [1-3]:",
    ]
    const req = detectPermission(lines, "test-agent")
    expect(req).toBeDefined()
    expect(req!.what).toBe("Execute this command?")
    expect(req!.kind).toBe("shell")
    expect(req!.target).toBe("rm -rf dist/")
    expect(req!.answers).toEqual([
      { label: "Consenti una volta", send: "1", tone: "primary" },
      { label: "Sì, e non chiedere più", send: "2", tone: "secondary" },
      { label: "No", send: "3", tone: "secondary" },
    ])
  })

  test("detects file write target with bracketed choices", () => {
    const lines = [
      "The agent wants to write to packages/ade/src/session/stream.ts",
      "Confirm action?",
      "  [1] Approve",
      "  [2] Reject",
    ]
    const req = detectPermission(lines, "test-agent")
    expect(req).toBeDefined()
    expect(req!.kind).toBe("write")
    expect(req!.target).toBe("packages/ade/src/session/stream.ts")
    expect(req!.answers).toEqual([
      { label: "Sì", send: "1", tone: "primary" },
      { label: "No", send: "2", tone: "secondary" },
    ])
  })
})

describe("detectPermission - [y/N] and (y/n) prompts", () => {
  test("detects [y/N] with default No (primary tone on No)", () => {
    const lines = ["Allow execution of `git reset --hard HEAD~1`? [y/N]"]
    const req = detectPermission(lines, "test-agent")
    expect(req).toBeDefined()
    expect(req!.what).toBe("Allow execution of `git reset --hard HEAD~1`? [y/N]")
    expect(req!.kind).toBe("shell")
    expect(req!.target).toBe("git reset --hard HEAD~1")
    expect(req!.answers).toEqual([
      { label: "Sì", send: "y", tone: "secondary" },
      { label: "No", send: "n", tone: "primary" },
    ])
  })

  test("detects [Y/n] with default Yes (primary tone on Yes)", () => {
    const lines = ["Apply changes to packages/ade/src/session/permission.ts? [Y/n]"]
    const req = detectPermission(lines, "test-agent")
    expect(req).toBeDefined()
    expect(req!.kind).toBe("write")
    expect(req!.target).toBe("packages/ade/src/session/permission.ts")
    expect(req!.answers).toEqual([
      { label: "Sì", send: "y", tone: "primary" },
      { label: "No", send: "n", tone: "secondary" },
    ])
  })

  test("detects network request URL in (y/n) prompt", () => {
    const lines = ["Allow network connection to https://api.github.com/repos? (y/n)"]
    const req = detectPermission(lines, "test-agent")
    expect(req).toBeDefined()
    expect(req!.kind).toBe("network")
    expect(req!.target).toBe("https://api.github.com/repos")
    expect(req!.answers).toEqual([
      { label: "Sì", send: "y", tone: "primary" },
      { label: "No", send: "n", tone: "secondary" },
    ])
  })

  test("detects 3-way prompt with always option [y/N/a]", () => {
    const lines = ["Run shell command: npm install? [y/N/a]"]
    const req = detectPermission(lines, "test-agent")
    expect(req).toBeDefined()
    expect(req!.kind).toBe("shell")
    expect(req!.target).toBe("npm install")
    expect(req!.answers).toEqual([
      { label: "Sì", send: "y", tone: "secondary" },
      { label: "No", send: "n", tone: "primary" },
      { label: "Sempre", send: "a", tone: "secondary" },
    ])
  })

  test("handles prompt with trailing cursor on separate line", () => {
    const lines = ["Do you want to proceed? [y/N]", ">"]
    const req = detectPermission(lines, "test-agent")
    expect(req).toBeDefined()
    expect(req!.what).toBe("Do you want to proceed? [y/N]")
    expect(req!.answers[0].send).toBe("y")
    expect(req!.answers[1].send).toBe("n")
  })
})

describe("detectPermission - Simple Question with Prompt", () => {
  test("detects question preceded by $ shell command", () => {
    const lines = ["$ git push origin main", "Run this shell command?", ">"]
    const req = detectPermission(lines, "test-agent")
    expect(req).toBeDefined()
    expect(req!.what).toBe("Run this shell command?")
    expect(req!.kind).toBe("shell")
    expect(req!.target).toBe("git push origin main")
    expect(req!.answers).toEqual([
      { label: "Consenti", send: "y", tone: "primary" },
      { label: "Nega", send: "n", tone: "secondary" },
    ])
  })

  test("detects file write question", () => {
    const lines = ["Modifying file packages/ade/package.json", "Allow file modification?"]
    const req = detectPermission(lines, "test-agent")
    expect(req).toBeDefined()
    expect(req!.kind).toBe("write")
    expect(req!.target).toBe("packages/ade/package.json")
    expect(req!.answers).toEqual([
      { label: "Consenti", send: "y", tone: "primary" },
      { label: "Nega", send: "n", tone: "secondary" },
    ])
  })
})

describe("detectPermission - False Positives (must return undefined)", () => {
  test("diff line addition with ternary operator containing ?", () => {
    const lines = [
      "--- a/src/index.ts",
      "+++ b/src/index.ts",
      "@@ -15,3 +15,4 @@",
      "+ const isReady = state === 'done' ? true : false;",
    ]
    expect(detectPermission(lines, "test-agent")).toBeUndefined()
  })

  test("diff line with optional chaining containing ?", () => {
    const lines = ["- return session?.agent?.status;"]
    expect(detectPermission(lines, "test-agent")).toBeUndefined()
  })

  test("test runner passing output with question in test title", () => {
    const lines = [
      "bun test v1.4.0",
      "✓ detectPermission > handles ? in prompts (2ms)",
      "PASS packages/ade/src/session/stream.test.ts (1.2s)",
      "Tests: 552 passed, 552 total",
    ]
    expect(detectPermission(lines, "test-agent")).toBeUndefined()
  })

  test("rhetorical question inside agent reasoning/thinking", () => {
    const lines = ["Thinking: Why did this compilation step fail? Let me inspect the error log."]
    expect(detectPermission(lines, "test-agent")).toBeUndefined()
  })

  test("progress bar with percentage and download rate", () => {
    const lines = ["[===================>       ] 75% 4.5MB/s ETA: 2s"]
    expect(detectPermission(lines, "test-agent")).toBeUndefined()
  })

  test("action plan numbered list describing upcoming steps", () => {
    const lines = [
      "Steps to complete the task:",
      "  1. First create the module file",
      "  2. Next write the accompanying unit tests",
      "  3. Finally verify with bun test",
    ]
    expect(detectPermission(lines, "test-agent")).toBeUndefined()
  })

  test("stack trace line with error location", () => {
    const lines = ["Error: file not found", "    at Object.readFile (fs.ts:120:15)"]
    expect(detectPermission(lines, "test-agent")).toBeUndefined()
  })

  test("empty lines or whitespace-only buffer", () => {
    expect(detectPermission([], "test-agent")).toBeUndefined()
    expect(detectPermission(["", "   ", "\n"], "test-agent")).toBeUndefined()
  })
})

describe("detectPermission - ANSI handling", () => {
  test("strips ANSI decorations from question and options", () => {
    const lines = [
      "\x1b[1m\x1b[33mDo you want to run this command?\x1b[0m",
      "  \x1b[32m1.\x1b[0m Yes",
      "  \x1b[31m2.\x1b[0m No",
    ]
    const req = detectPermission(lines, "test-agent")
    expect(req).toBeDefined()
    expect(req!.what).toBe("Do you want to run this command?")
    expect(req!.answers.length).toBe(2)
    expect(req!.answers[0].send).toBe("1")
    expect(req!.answers[1].send).toBe("2")
  })
})

describe("isResolved", () => {
  const dummyRequest: PermissionRequest = {
    what: "Do you want to run this command? [y/N]",
    kind: "shell",
    target: "git status",
    answers: [
      { label: "Sì", send: "y", tone: "secondary" },
      { label: "No", send: "n", tone: "primary" },
    ],
  }

  const resolved = (lines: string[]) => isResolved(dummyRequest, lines, "claude-code")

  test("returns false when newLines is empty", () => {
    expect(resolved([])).toBe(false)
  })

  test("returns false when newLines contains only empty strings or whitespace", () => {
    expect(resolved(["", "   ", "\n"])).toBe(false)
  })

  test("returns false when newLines only echoes the prompt or question", () => {
    expect(resolved(["Do you want to run this command? [y/N]"])).toBe(false)
    expect(resolved([">"])).toBe(false)
    expect(resolved([":"])).toBe(false)
  })

  test("returns true when newLines contains actual process output", () => {
    const newLines = ["Running command...", "$ git status", "On branch main"]
    expect(resolved(newLines)).toBe(true)
  })

  test("returns true when newLines contains user response or error", () => {
    expect(resolved(["Action denied by user."])).toBe(true)
    expect(resolved(["1"])).toBe(true)
    expect(resolved(["y"])).toBe(true)
  })

  /*
   * The agents that ask these questions draw them with Ink or ratatui, which
   * repaint the whole frame several times a second while they wait. Every
   * repaint is new output, and "new output" used to mean "answered": the first
   * frame after a question was detected cleared the request and set the pane
   * back to "In esecuzione" while the agent was still waiting for a keystroke.
   */
  describe("a redrawn frame is not an answer", () => {
    test("the question repainted among other lines is still the question", () => {
      const frame = ["  Esecuzione comando", "  $ git status", "Do you want to run this command? [y/N]"]
      expect(resolved(frame)).toBe(false)
    })

    test("a spinner drawn under the question does not resolve it", () => {
      expect(resolved(["Do you want to run this command? [y/N]", ""])).toBe(false)
    })

    test("the question gone means answered", () => {
      expect(resolved(["On branch main", "nothing to commit"])).toBe(true)
    })

    test("a different question means the old one is done", () => {
      // Resolved from this request's point of view; the next read picks the
      // new one up as a request of its own.
      expect(resolved(["Vuoi sovrascrivere src/app.ts? [y/N]"])).toBe(true)
    })
  })
})
