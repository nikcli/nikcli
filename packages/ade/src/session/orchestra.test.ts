import { describe, expect, test } from "bun:test"
import {
  checkName,
  depthOf,
  descendants,
  excludeWithAde,
  modelArgs,
  nameTaken,
  resultsDir,
  slugify,
  withoutModel,
  worktreeArgs,
  worktreePlan,
  effortArgs,
  withoutEffort,
  dispatchChoice,
  isBaseRef,
  worktreeAddArgs,
} from "./orchestra"

describe("names", () => {
  test("a usable name comes back trimmed", () => {
    expect(checkName("  revisore test ")).toEqual({ name: "revisore test" })
  })

  test("names the agent could not address afterwards are refused", () => {
    for (const bad of ["", "   ", "12", "web/api", 'a"b', "x".repeat(41)]) {
      expect("error" in checkName(bad)).toBe(true)
    }
  })

  test("a taken name is taken whatever the case", () => {
    expect(nameTaken(["Revisore", "codex"], "revisore")).toBe(true)
    expect(nameTaken(["Revisore"], "revisore-2")).toBe(false)
  })

  test("slugify makes a branch segment", () => {
    expect(slugify("Revisione più rapida!")).toBe("revisione-piu-rapida")
    expect(slugify("???")).toBe("sessione")
  })
})

test("a worktree goes beside the project, never inside a folder named like the user's own ADE worktree", () => {
  expect(worktreePlan("C:\\Users\\me\\Favorites\\nikcli\\", "revisore")).toEqual({
    branch: "ade/revisore",
    path: "C:\\Users\\me\\Favorites\\nikcli-worktrees\\revisore",
    container: "C:\\Users\\me\\Favorites\\nikcli-worktrees",
  })
  expect(worktreePlan("/home/me/app", "x").path).toBe("/home/me/app-worktrees/x")
  expect(worktreePlan("C:\\Users\\me\\Favorites\\nikcli", "codex").path).not.toContain("nikcli-ade")
})

test("a worktree starts from the base asked for, and a base cannot be an option", () => {
  const plan = { branch: "ade/codex", path: "/w/codex" }
  expect(worktreeAddArgs(plan, "feat/ade")).toEqual(["worktree", "add", "-b", "ade/codex", "/w/codex", "feat/ade"])
  expect(worktreeAddArgs(plan)).toEqual(["worktree", "add", "-b", "ade/codex", "/w/codex"])
  expect(isBaseRef("feat/ade")).toBe(true)
  expect(isBaseRef("3fdf4d7bb")).toBe(true)
  expect(isBaseRef("--force")).toBe(false)
  expect(isBaseRef("a..b")).toBe(false)
})

describe("the tree of sessions", () => {
  const parents = new Map([
    ["child", "root"],
    ["grandchild", "child"],
    ["sibling", "root"],
  ])
  const parentOf = (id: string) => parents.get(id)

  test("depth counts the spawns above a session", () => {
    expect(depthOf("root", parentOf)).toBe(0)
    expect(depthOf("child", parentOf)).toBe(1)
    expect(depthOf("grandchild", parentOf)).toBe(2)
  })

  test("a cycle ends the count", () => {
    const loop = new Map([
      ["a", "b"],
      ["b", "a"],
    ])
    expect(depthOf("a", (id) => loop.get(id))).toBe(1)
  })

  test("descendants come children-last, so each closes before its parent", () => {
    const below = descendants("root", parents)
    expect(below).toContain("sibling")
    expect(below.indexOf("grandchild")).toBeLessThan(below.indexOf("child"))
    expect(descendants("grandchild", parents)).toEqual([])
  })
})

describe("options a session may choose for its subagent", () => {
  test("the model, with the flag each CLI takes", () => {
    expect(modelArgs("claude-code", "sonnet")).toEqual(["--model", "sonnet"])
    expect(modelArgs("codex", "gpt-5-codex")).toEqual(["-m", "gpt-5-codex"])
    expect(modelArgs("agy", "gemini-3.1-pro-high")).toEqual(["--model", "gemini-3.1-pro-high"])
  })

  test("not a way to smuggle other arguments in", () => {
    expect("error" in (modelArgs("claude-code", "x --dangerously-skip-permissions") as object)).toBe(true)
    expect("error" in (modelArgs("kimi", "k2") as object)).toBe(true)
  })

  test("agy is told about its worktree, the others start in it", () => {
    expect(worktreeArgs("agy", "C:\\w\\x")).toEqual(["--add-dir", "C:\\w\\x"])
    expect(worktreeArgs("codex", "C:\\w\\x")).toEqual([])
  })
})

test("results live in .ade/results, kept out of git once", () => {
  expect(resultsDir("C:\\p\\app")).toBe("C:\\p\\app\\.ade\\results")
  expect(excludeWithAde("*.log")).toBe("*.log\n# ADE: risultati dei subagent\n.ade/\n")
  expect(excludeWithAde("# x\n.ade/\n")).toBeUndefined()
})

test("withoutModel takes the model choice out and leaves the rest", () => {
  expect(withoutModel(["--model", "a", "--add-dir", "C:\\w"])).toEqual(["--add-dir", "C:\\w"])
  expect(withoutModel(["-m", "gpt-5"])).toEqual([])
})
describe("effort and dispatch profiles at spawn", () => {
  test("each agent is told the effort its own way, and one that cannot be told is refused", () => {
    expect(effortArgs("claude-code", "XHigh")).toEqual(["--effort", "xhigh"])
    expect(effortArgs("claude-code", "low", "sonnet")).toEqual(["--effort", "low"])
    expect(effortArgs("codex", "high")).toEqual(["-c", 'model_reasoning_effort="high"'])
    expect(effortArgs("agy", "max")).toEqual({ error: expect.stringContaining("low, medium, high") })
  })

  test("an effort the model would ignore is refused, as the transcripts showed", () => {
    expect(effortArgs("claude-code", "low", "haiku")).toEqual({ error: expect.stringContaining("ignora l'effort") })
    // agy carries the effort in the model id; its --effort flag is not applied.
    expect(effortArgs("agy", "medium", "gemini-3.8-flash-medium")).toEqual([])
    expect(effortArgs("agy", "high", "gemini-3.8-flash-medium")).toEqual({
      error: expect.stringContaining("gemini-3.8-flash-high"),
    })
    expect(effortArgs("agy", "high")).toEqual({ error: expect.stringContaining("--model") })
    expect(effortArgs("agy", "high", "claude-sonnet-4-6")).toEqual({ error: expect.stringContaining("non ha livelli") })
    expect(effortArgs("nikcli", "high")).toEqual({ error: expect.stringContaining("variant") })
    expect(effortArgs("opencode", "high")).toEqual({ error: expect.stringContaining("senza --effort") })
  })

  test("a relaunch can replace the effort", () => {
    expect(withoutEffort(["--model", "haiku", "--effort", "low"])).toEqual(["--model", "haiku"])
    expect(withoutEffort(["-c", 'model_reasoning_effort="high"', "-c", 'sandbox_mode="x"'])).toEqual([
      "-c",
      'sandbox_mode="x"',
    ])
  })

  test("a profile gives the named agent its model and effort, and says why it cannot", () => {
    const json = JSON.stringify({
      classes: [
        {
          when: "revisione-audit",
          candidates: [{ agent: "claude-code", model: "claude-opus-5", effort: "high", why: "aderenza" }],
        },
        { when: "compito-piccolo", candidates: [{ agent: "agy", model: "gemini-3.8-flash-medium", effort: "medium" }] },
      ],
    })
    expect(dispatchChoice(json, "revisione-audit", "claude-code")).toEqual({
      model: "claude-opus-5",
      effort: "high",
      why: "aderenza",
    })
    expect(dispatchChoice(json, "revisione-audit", "agy")).toEqual({
      error: expect.stringContaining("candidati claude-code"),
    })
    expect(dispatchChoice(json, "boh", "agy")).toEqual({
      error: expect.stringContaining("revisione-audit, compito-piccolo"),
    })
    expect(dispatchChoice("{", "x", "agy")).toEqual({ error: "dispatch.json non è JSON valido" })
  })
})
