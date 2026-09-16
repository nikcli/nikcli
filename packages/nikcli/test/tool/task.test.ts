import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { selectSubagentModel, TaskTool } from "@/tool/task"
import { Instance } from "@/project/instance"
import { withProjectDirectory } from "../helpers/tool-context"

/**
 * TaskTool.spawns full agent loops (LLM + Session). Keep this file to
 * schema/init surface only; behavioural coverage lives in integration suites.
 * `init()` lists agents under Instance ALS, so wrap with `withProjectDirectory`.
 */
describe("TaskTool parameters", () => {
  let projectDir: string
  let testHome: string
  let def: Awaited<ReturnType<typeof TaskTool.init>>
  const previousHome = process.env.NIKCLI_TEST_HOME
  const previousDisable = process.env.NIKCLI_DISABLE_PROJECT_CONFIG

  beforeAll(async () => {
    testHome = await fs.mkdtemp(path.join(os.tmpdir(), "nikcli-task-home-"))
    process.env.NIKCLI_TEST_HOME = testHome
    process.env.NIKCLI_DISABLE_PROJECT_CONFIG = "1"
    projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "nikcli-task-proj-"))
    def = await withProjectDirectory(projectDir, () => TaskTool.init())
  })

  afterAll(async () => {
    await Instance.disposeAll().catch(() => undefined)
    if (previousHome === undefined) delete process.env.NIKCLI_TEST_HOME
    else process.env.NIKCLI_TEST_HOME = previousHome
    if (previousDisable === undefined) delete process.env.NIKCLI_DISABLE_PROJECT_CONFIG
    else process.env.NIKCLI_DISABLE_PROJECT_CONFIG = previousDisable
    await fs.rm(projectDir, { recursive: true, force: true }).catch(() => {})
    await fs.rm(testHome, { recursive: true, force: true }).catch(() => {})
  })

  it("requires description, prompt, and subagent_type", () => {
    expect(() => def.parameters.parse({})).toThrow()
    expect(() =>
      def.parameters.parse({
        description: "do thing",
        prompt: "please do the thing",
        subagent_type: "explore",
      }),
    ).not.toThrow()
  })

  it("defaults background to true", () => {
    const parsed = def.parameters.parse({
      description: "bg task",
      prompt: "run in background",
      subagent_type: "explore",
    })
    expect(parsed.background).toBe(true)
  })

  it("embeds accessible agents in the description", () => {
    expect(def.description.length).toBeGreaterThan(0)
  })

  it("accepts an optional model override", () => {
    const parsed = def.parameters.parse({
      description: "review diff",
      prompt: "review the diff",
      subagent_type: "explore",
      model: "anthropic/claude-opus-4-5",
    })
    expect(parsed.model).toBe("anthropic/claude-opus-4-5")
    expect(
      def.parameters.parse({
        description: "review diff",
        prompt: "review the diff",
        subagent_type: "explore",
      }).model,
    ).toBeUndefined()
  })
})

describe("selectSubagentModel", () => {
  const candidates = [
    {
      providerID: "anthropic",
      modelID: "claude-opus-4-1",
      name: "Claude Opus 4.1",
      releaseDate: "2025-08-05",
    },
    {
      providerID: "anthropic",
      modelID: "claude-opus-4-5",
      name: "Claude Opus 4.5",
      releaseDate: "2025-11-24",
    },
    {
      providerID: "anthropic",
      modelID: "claude-sonnet-4-5",
      name: "Claude Sonnet 4.5",
      releaseDate: "2025-09-29",
    },
    {
      providerID: "openai",
      modelID: "gpt-5",
      name: "GPT-5",
      releaseDate: "2025-08-07",
    },
    {
      providerID: "opencode",
      modelID: "claude-opus-4-5",
      name: "Claude Opus 4.5",
      releaseDate: "2025-11-24",
    },
  ]

  it("takes an exact providerID/modelID", () => {
    expect(selectSubagentModel(candidates, "opencode/claude-opus-4-5", "anthropic")).toEqual({
      providerID: "opencode",
      modelID: "claude-opus-4-5",
    })
  })

  it("resolves a fragment that fits one model", () => {
    expect(selectSubagentModel(candidates, "sonnet", "anthropic")).toEqual({
      providerID: "anthropic",
      modelID: "claude-sonnet-4-5",
    })
  })

  it("asks rather than guessing when a fragment fits several variants", () => {
    // Two opus releases from the same provider: "newest" is not a decision
    // this function is entitled to make on the user's behalf.
    expect(() => selectSubagentModel(candidates, "opus", "anthropic")).toThrow(/matches 2 models/)
    expect(() => selectSubagentModel(candidates, "opus", "anthropic")).toThrow(/claude-opus-4-5/)
  })

  it("takes a full model id over the longer variants that contain it", () => {
    const withVariants = [
      ...candidates,
      {
        providerID: "anthropic",
        modelID: "claude-opus-4-5-thinking",
        name: "Claude Opus 4.5 Thinking",
        releaseDate: "2025-11-24",
      },
    ]
    expect(selectSubagentModel(withVariants, "claude-opus-4-5", "anthropic")).toEqual({
      providerID: "anthropic",
      modelID: "claude-opus-4-5",
    })
  })

  it("matches a display name written with spaces and dots", () => {
    expect(selectSubagentModel(candidates, "Claude Sonnet 4.5", "anthropic")).toEqual({
      providerID: "anthropic",
      modelID: "claude-sonnet-4-5",
    })
  })

  it("prefers the session provider when the same model exists on several", () => {
    expect(selectSubagentModel(candidates, "claude-opus-4-5", "opencode")).toEqual({
      providerID: "opencode",
      modelID: "claude-opus-4-5",
    })
  })

  it("scopes a fragment to the provider it is written with", () => {
    // "opus" fits two anthropic models but only one opencode model, so the
    // provider prefix is what makes it answerable.
    expect(selectSubagentModel(candidates, "opencode/opus", "anthropic")).toEqual({
      providerID: "opencode",
      modelID: "claude-opus-4-5",
    })
  })

  it("widens past an unknown provider rather than failing", () => {
    expect(selectSubagentModel(candidates, "bedrock/gpt-5", "anthropic")).toEqual({
      providerID: "openai",
      modelID: "gpt-5",
    })
  })

  it("throws with the candidate list when nothing matches", () => {
    expect(() => selectSubagentModel(candidates, "gemini", "anthropic")).toThrow(/No model matches "gemini"/)
    expect(() => selectSubagentModel(candidates, "gemini", "anthropic")).toThrow(/openai\/gpt-5/)
  })

  it("leads the failure with the models closest to what was asked for", () => {
    let message = ""
    try {
      selectSubagentModel(candidates, "claude opus 9", "anthropic")
    } catch (error) {
      message = error instanceof Error ? error.message : String(error)
    }
    const listed = message.slice(message.indexOf(":") + 1)
    // Every claude entry shares tokens with the query; the lone gpt one shares
    // none, so it must not crowd out the near misses.
    expect(listed).toContain("anthropic/claude-opus-4-5")
    expect(listed).toContain("opencode/claude-opus-4-5")
    expect(listed).not.toContain("openai/gpt-5")
    expect(message).toContain("of 5 available")
  })

  it("rejects an empty model", () => {
    expect(() => selectSubagentModel(candidates, "   ", "anthropic")).toThrow()
  })
})
