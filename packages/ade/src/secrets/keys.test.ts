import { describe, expect, test } from "bun:test"
import {
  addedLabel,
  billingWarning,
  envProblem,
  keysForAgent,
  nameProblem,
  runKeysCommand,
  suggestEnv,
  valueProblem,
  type KeyInfo,
} from "./keys"

const key = (name: string, env: string, agents: string[], masked: string | null = "••••••••abcd"): KeyInfo => ({
  name,
  env,
  agents,
  createdMs: 0,
  ...(masked ? { masked } : {}),
})

describe("the form's checks match the host's", () => {
  test("names", () => {
    expect(nameProblem("GitHub token")).toBeUndefined()
    expect(nameProblem(" ")).toBe("serve un nome")
    expect(nameProblem("../etc")).toBe("lettere, cifre, spazio, . _ -")
  })

  test("variables: shape, reserved, and one key per variable", () => {
    expect(envProblem("OPENAI_API_KEY")).toBeUndefined()
    expect(envProblem("openai")).toBe("maiuscole, cifre e _, es. OPENAI_API_KEY")
    expect(envProblem("PATH")).toBe("PATH è riservata")
    expect(envProblem("ADE_PANE_TOKEN")).toBe("ADE_PANE_TOKEN è riservata")
    const others = [key("OpenAI", "OPENAI_API_KEY", [])]
    expect(envProblem("OPENAI_API_KEY", others, "Altra")).toBe("OPENAI_API_KEY è già di un'altra chiave")
    expect(envProblem("OPENAI_API_KEY", others, "OpenAI")).toBeUndefined()
  })

  test("values are one line", () => {
    expect(valueProblem("sk-abc")).toBeUndefined()
    expect(valueProblem("sk-\nabc")).toBe("contiene un a capo: incollalo su una riga")
    expect(valueProblem("")).toBe("incolla il valore")
  })
})

describe("launch", () => {
  test("a session gets only the keys that name its agent, and none by default", () => {
    const keys = [
      key("Anthropic", "ANTHROPIC_API_KEY", []),
      key("OpenAI", "OPENAI_API_KEY", ["codex", "nikcli"]),
      key("Lost", "LOST_KEY", ["codex"], null),
    ]
    expect(keysForAgent(keys, "claude-code")).toEqual([])
    expect(keysForAgent(keys, "codex")).toEqual(["OpenAI"])
  })

  test("the variables that switch an agent to paid API use are called out", () => {
    expect(billingWarning("ANTHROPIC_API_KEY", "claude-code")).toBe(
      "Claude Code userà questa chiave invece dell'abbonamento Claude: consumo a pagamento",
    )
    expect(billingWarning("ANTHROPIC_API_KEY", "nikcli")).toBeUndefined()
    expect(billingWarning("OPENAI_API_KEY", "codex")).toContain("Codex")
  })

  test("a variable is suggested from the name", () => {
    expect(suggestEnv("OpenAI")).toBe("OPENAI_API_KEY")
    expect(suggestEnv("GitHub token")).toBe("GITHUB_TOKEN")
    expect(suggestEnv("stripe api")).toBe("STRIPE_API_KEY")
    expect(suggestEnv("1password")).toBe("_1PASSWORD_API_KEY")
    expect(addedLabel(0, 1)).toBe("")
    expect(addedLabel(1, 1 + 3 * 86_400_000)).toBe("aggiunta 3 giorni fa")
  })
})

describe("@ade keys", () => {
  const request = (verb: string, ...args: string[]) => ({ panel: "keys", verb, args, raw: "" })

  test("list says names, variables and agents, never a masked value", async () => {
    const outcome = await runKeysCommand(
      { list: async () => [key("OpenAI", "OPENAI_API_KEY", ["codex"])], ask: () => {} },
      request("list"),
    )
    expect(outcome).toEqual({ ok: true, detail: "OpenAI → OPENAI_API_KEY (codex)" })
    expect(JSON.stringify(outcome)).not.toContain("abcd")
  })

  test("ask opens the dialog with the variable and the reason", async () => {
    const asked: string[][] = []
    const controller = { list: async () => [], ask: (env: string, reason: string) => void asked.push([env, reason]) }
    expect(await runKeysCommand(controller, request("ask", "STRIPE_SECRET_KEY", "per", "i", "test"))).toMatchObject({
      ok: true,
    })
    expect(asked).toEqual([["STRIPE_SECRET_KEY", "per i test"]])
    expect(await runKeysCommand(controller, request("ask", "PATH"))).toEqual({
      ok: false,
      reason: "variabile: PATH è riservata",
    })
    expect(asked).toHaveLength(1)
  })
})
