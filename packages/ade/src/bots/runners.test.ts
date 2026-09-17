import { describe, expect, test } from "bun:test"
import type { AgentFile } from "./nikcli"
import {
  answerSoFar,
  applyRunnerLine,
  enforcesDisabledTools,
  finalText,
  readLoginStatus,
  runnerById,
  turnCommand,
} from "./runners"
import { emptyTalk, sendMessage, type Talk } from "./talk"

const bot: AgentFile = {
  identifier: "tester",
  path: "C:/p/.nikcli/agent/tester.md",
  scope: "project",
  description: "Scrive i test.",
  mode: "primary",
  prompt: "Sei un tester.",
  disabledTools: [],
}

function fold(runnerId: string, lines: readonly string[]): Talk {
  const runner = runnerById(runnerId)
  return lines.reduce((talk, line) => applyRunnerLine(runner, talk, line, 1000), sendMessage(emptyTalk(), "ciao", 1))
}

describe("il motore di un bot", () => {
  test("senza chiave è nikcli, e una chiave sconosciuta pure", () => {
    expect(runnerById(undefined).id).toBe("nikcli")
    expect(runnerById("boh").id).toBe("nikcli")
    expect(runnerById("claude").label).toBe("Claude Code")
  })
})

describe("gli argomenti di un turno", () => {
  test("nikcli resta `run --agent`", () => {
    const { command, args } = turnCommand(runnerById("nikcli"), {
      bot: { ...bot, model: "openai/gpt-5.5" },
      message: "ciao",
    })
    expect(command).toBe("nikcli")
    expect(args.slice(0, 3)).toEqual(["run", "--agent", "tester"])
    expect(args).toContain("openai/gpt-5.5")
  })

  test("Claude Code: stream-json, persona come system prompt, sessione ripresa, messaggio dopo --", () => {
    const { command, args } = turnCommand(runnerById("claude"), {
      bot: { ...bot, model: "sonnet", effort: "high", disabledTools: ["bash"] },
      message: "-x ciao",
      sessionId: "abc",
    })
    expect(command).toBe("claude")
    expect(args.slice(0, 4)).toEqual(["-p", "--output-format", "stream-json", "--verbose"])
    expect(args[args.indexOf("--model") + 1]).toBe("sonnet")
    expect(args[args.indexOf("--effort") + 1]).toBe("high")
    expect(args[args.indexOf("--append-system-prompt") + 1]).toBe("Sei un tester.")
    expect(args[args.indexOf("--resume") + 1]).toBe("abc")
    expect(args[args.indexOf("--allowedTools") + 1]).not.toContain("Bash")
    expect(args[args.indexOf("--disallowedTools") + 1]).toContain("Bash")
    expect(args.slice(-2)).toEqual(["--", "-x ciao"])
  })

  test("Codex: il primo turno porta la persona, il seguito riprende il thread", () => {
    const first = turnCommand(runnerById("codex"), { bot: { ...bot, effort: "low" }, message: "ciao" })
    expect(first.args.slice(0, 2)).toEqual(["exec", "--json"])
    expect(first.args).toContain('model_reasoning_effort="low"')
    expect(first.args.at(-1)).toContain("Sei un tester.")
    expect(first.args.at(-1)?.endsWith("ciao")).toBe(true)

    const next = turnCommand(runnerById("codex"), { bot, message: "e poi?", sessionId: "t-1" })
    expect(next.args.slice(0, 3)).toEqual(["exec", "resume", "--json"])
    expect(next.args.slice(-2)).toEqual(["t-1", "e poi?"])
  })

  test("un turno leggero di Claude Code salta MCP e impostazioni utente, ma può usare ade-msg", () => {
    const { args } = turnCommand(runnerById("claude"), { bot, message: "x", lean: true })
    expect(args).toContain("--strict-mcp-config")
    expect(args[args.indexOf("--mcp-config") + 1]).toBe('{"mcpServers":{}}')
    expect(args[args.indexOf("--setting-sources") + 1]).toBe("local")
    expect(args[args.indexOf("--settings") + 1]).toBe('{"autoMemoryEnabled":false}')
    expect(args[args.indexOf("--allowedTools") + 1]).toContain("PowerShell(ade-msg *)")
    expect(turnCommand(runnerById("claude"), { bot, message: "x" }).args).not.toContain("--strict-mcp-config")
  })

  test("un bot che non può scrivere gira in sola lettura", () => {
    const { args } = turnCommand(runnerById("codex"), { bot: { ...bot, disabledTools: ["edit"] }, message: "x" })
    expect(args).toContain('sandbox_mode="read-only"')
  })

  test("un turno vocale non scrive e non esegue altro che ade-msg, su ogni motore che lo sa rifiutare", () => {
    const voice = { ...bot, disabledTools: ["edit", "write", "bash"] }

    const claude = turnCommand(runnerById("claude"), { bot: voice, message: "x", lean: true }).args
    const allowed = claude[claude.indexOf("--allowedTools") + 1]!.split(",")
    const disallowed = claude[claude.indexOf("--disallowedTools") + 1]!.split(",")
    expect(claude[claude.indexOf("--permission-mode") + 1]).toBe("default")
    // No settings file, the project's local one included, can pre-approve a command.
    expect(claude[claude.indexOf("--setting-sources") + 1]).toBe("")
    expect(allowed).toContain("Bash(ade-msg *)")
    expect(allowed).toContain("PowerShell(ade-msg *)")
    for (const tool of ["Bash", "PowerShell", "Edit", "Write", "NotebookEdit"]) expect(allowed).not.toContain(tool)
    expect(disallowed).toEqual(expect.arrayContaining(["Edit", "Write", "NotebookEdit"]))
    // A refusal beats an allow: refusing Bash would refuse ade-msg too.
    expect(disallowed).not.toContain("Bash")

    const outbox = "C:/Users/x/AppData/Local/ai.nikcli.ade/mailbox/outbox"
    const codex = turnCommand(runnerById("codex"), { bot: voice, message: "x", outbox })
    expect(codex.args).toContain('sandbox_mode="workspace-write"')
    expect(codex.cwd).toBe(outbox)
    const resumed = turnCommand(runnerById("codex"), { bot: voice, message: "x", sessionId: "t-1", outbox })
    expect(resumed.cwd).toBe(outbox)
    expect(resumed.args).toContain('sandbox_mode="workspace-write"')
    // Without an outbox there is nothing to make writable: fully read-only, and the project's cwd.
    const plain = turnCommand(runnerById("codex"), { bot: voice, message: "x" })
    expect(plain.args).toContain('sandbox_mode="read-only"')
    expect(plain.cwd).toBeUndefined()
    // A bot that may write keeps its project as the workspace.
    expect(turnCommand(runnerById("codex"), { bot, message: "x", outbox }).cwd).toBeUndefined()

    expect(enforcesDisabledTools("claude")).toBe(true)
    expect(enforcesDisabledTools("codex")).toBe(true)
    expect(enforcesDisabledTools("nikcli")).toBe(false)
  })
})

describe("gli eventi di Claude Code", () => {
  const lines = [
    '{"type":"system","subtype":"init","cwd":"C:\\\\p","session_id":"25013bee","tools":["Read"]}',
    '{"type":"assistant","message":{"content":[{"type":"thinking","thinking":""}]},"session_id":"25013bee"}',
    '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"toolu_1","name":"Read","input":{"file_path":"C:\\\\p\\\\package.json"}}]},"session_id":"25013bee"}',
    '{"type":"user","message":{"role":"user","content":[{"tool_use_id":"toolu_1","type":"tool_result","content":"1\\t{\\n2\\t  \\"name\\": \\"@nikcli-ai/ade\\""}]},"session_id":"25013bee"}',
    '{"type":"assistant","message":{"content":[{"type":"text","text":"`@nikcli-ai/ade`"}]},"session_id":"25013bee"}',
    '{"type":"result","subtype":"success","is_error":false,"session_id":"25013bee","total_cost_usd":0.04,"usage":{"input_tokens":18,"cache_creation_input_tokens":100,"cache_read_input_tokens":200,"output_tokens":6,"server_tool_use":{"web_search_requests":0}},"permission_denials":[]}',
  ]

  test("sessione, strumento con il suo output, risposta, costo", () => {
    const talk = fold("claude", lines)
    expect(talk.sessionId).toBe("25013bee")
    const [, tool, reply] = talk.messages
    expect(tool).toMatchObject({ role: "tool", tool: "Read", text: "C:\\p\\package.json" })
    expect(tool?.output).toContain("@nikcli-ai/ade")
    expect(reply).toMatchObject({ role: "bot", text: "`@nikcli-ai/ade`" })
    expect(talk.tokens).toBe(324)
    expect(talk.costUsd).toBeCloseTo(0.04)
  })

  test("un permesso negato si dice sul thread", () => {
    const talk = fold("claude", [
      '{"type":"result","is_error":false,"session_id":"s","permission_denials":[{"tool_name":"Bash","tool_input":{}}]}',
    ])
    expect(talk.messages.at(-1)).toMatchObject({ role: "error" })
    expect(talk.messages.at(-1)?.text).toContain("Bash")
  })

  test("una conversazione che Claude Code non ha più si dimentica", () => {
    const talk = fold("claude", [
      '{"type":"system","subtype":"init","session_id":"vecchia"}',
      '{"type":"result","subtype":"error_during_execution","is_error":true,"session_id":"vecchia","errors":["No conversation found with session ID: vecchia"]}',
    ])
    expect(talk.sessionId).toBeUndefined()
    expect(talk.messages.at(-1)?.text).toContain("nuova")
  })

  test("un risultato in errore mette il thread in errore", () => {
    const talk = fold("claude", ['{"type":"result","is_error":true,"result":"Credit balance is too low"}'])
    expect(talk.status).toBe("error")
    expect(talk.messages.at(-1)?.text).toBe("Credit balance is too low")
  })
})

describe("gli eventi di Codex", () => {
  test("thread, comando con output, risposta, token senza contare due volte la cache", () => {
    const talk = fold("codex", [
      '{"type":"thread.started","thread_id":"01a0a471"}',
      '{"type":"turn.started"}',
      '{"type":"item.started","item":{"id":"item_0","type":"command_execution","command":"git branch --show-current","aggregated_output":"","status":"in_progress"}}',
      '{"type":"item.completed","item":{"id":"item_0","type":"command_execution","command":"git branch --show-current","aggregated_output":"feat/ade\\n","exit_code":0,"status":"completed"}}',
      '{"type":"item.completed","item":{"id":"item_1","type":"agent_message","text":"Il branch corrente è `feat/ade`."}}',
      '{"type":"turn.completed","usage":{"input_tokens":32962,"cached_input_tokens":20224,"output_tokens":65,"reasoning_output_tokens":0}}',
    ])
    expect(talk.sessionId).toBe("01a0a471")
    expect(talk.messages).toHaveLength(3)
    expect(talk.messages[1]).toMatchObject({ role: "tool", tool: "shell", output: "feat/ade\n" })
    expect(talk.messages[2]).toMatchObject({ role: "bot", text: "Il branch corrente è `feat/ade`." })
    expect(talk.tokens).toBe(33027)
  })

  test("un turno fallito è un errore", () => {
    const talk = fold("codex", ['{"type":"turn.failed","error":{"message":"usage limit reached"}}'])
    expect(talk.status).toBe("error")
    expect(talk.messages.at(-1)?.text).toBe("usage limit reached")
  })
})

describe("la risposta finale di un turno", () => {
  test("sono i messaggi del bot dopo l'ultima domanda, senza strumenti né errori", () => {
    const talk = fold("claude", [
      '{"type":"assistant","message":{"content":[{"type":"text","text":"Controllo."},{"type":"tool_use","id":"t1","name":"Bash","input":{"command":"ls"}}]}}',
      '{"type":"assistant","message":{"content":[{"type":"text","text":"Ci sono 3 file."}]}}',
    ])
    expect(finalText(talk)).toBe("Controllo.\n\nCi sono 3 file.")
    expect(finalText(sendMessage(talk, "e poi?", 2))).toBe("")
  })

  test("nikcli senza agente usa quello predefinito", () => {
    const { args } = turnCommand(runnerById("nikcli"), { bot: { ...bot, identifier: "" }, message: "ciao" })
    expect(args).not.toContain("--agent")
  })
})

describe("lo stato di accesso", () => {
  test("Claude Code con l'abbonamento", () => {
    const state = readLoginStatus(runnerById("claude"), '{\n  "loggedIn": true,\n  "authMethod": "claude.ai"\n}', 0)
    expect(state).toEqual({ state: "in", detail: "Abbonamento Claude" })
  })

  test("Claude Code senza accesso", () => {
    expect(readLoginStatus(runnerById("claude"), '{"loggedIn": false}', 1).state).toBe("out")
  })

  test("Codex con ChatGPT, e senza", () => {
    expect(readLoginStatus(runnerById("codex"), "Logged in using ChatGPT\r\n", 0)).toEqual({
      state: "in",
      detail: "Accesso con ChatGPT",
    })
    expect(readLoginStatus(runnerById("codex"), "Not logged in", 1).state).toBe("out")
  })

  test("nikcli che si ferma prima dell'elenco non dice «non collegato»", () => {
    expect(readLoginStatus(runnerById("nikcli"), "ERROR EPERM: operation not permitted fatal", 1).state).toBe("unknown")
    expect(readLoginStatus(runnerById("nikcli"), "└  0 credentials", 0).state).toBe("out")
  })

  test("nikcli elenca i provider, colori e cornici tolti", () => {
    const output = [
      "\u001b[90m┌\u001b[39m  Credentials \u001b[90m~\\AppData\\Local\\nikcli\\auth.json",
      "\u001b[90m│\u001b[39m",
      "\u001b[34m●\u001b[39m  OpenAI \u001b[90moauth",
      "\u001b[34m●\u001b[39m  Z.AI Coding Plan \u001b[90mapi",
      "\u001b[90m└\u001b[39m  2 credentials",
    ].join("\r\n")
    expect(readLoginStatus(runnerById("nikcli"), output, 0)).toEqual({
      state: "in",
      detail: "OpenAI, Z.AI Coding Plan",
    })
  })
})

describe("la risposta mentre Claude Code la scrive", () => {
  const ev = (event: object, parent: string | null = null) =>
    JSON.stringify({ type: "stream_event", event, session_id: "s", parent_tool_use_id: parent })
  const delta = (text: string, parent: string | null = null) =>
    ev({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } }, parent)

  test("chiesta con --include-partial-messages", () => {
    const { args } = turnCommand(runnerById("claude"), { bot, message: "ciao", partial: true })
    expect(args).toContain("--include-partial-messages")
    expect(turnCommand(runnerById("claude"), { bot, message: "ciao" }).args).not.toContain("--include-partial-messages")
  })

  test("cresce a ogni pezzo, e il messaggio completo la sostituisce senza ripeterla", () => {
    const seen: string[] = []
    let talk = fold("claude", ['{"type":"system","subtype":"init","session_id":"s"}'])
    const lines = [
      ev({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
      delta("Roma è la capitale d"),
      delta("'Italia. È antica"),
      delta("x", "toolu_sub"),
      '{"type":"assistant","message":{"content":[{"type":"text","text":"Roma è la capitale d\u0027Italia. È antica."}]},"session_id":"s","parent_tool_use_id":null}',
    ]
    for (const line of lines) {
      talk = applyRunnerLine(runnerById("claude"), talk, line, 0)
      seen.push(answerSoFar(talk))
    }
    expect(seen).toEqual([
      "",
      "Roma è la capitale d",
      "Roma è la capitale d'Italia. È antica",
      "Roma è la capitale d'Italia. È antica",
      "Roma è la capitale d'Italia. È antica.",
    ])
    expect(talk.streaming).toBeUndefined()
    expect(talk.messages.filter((m) => m.role === "bot")).toHaveLength(1)
  })

  test("un secondo messaggio si aggiunge al primo", () => {
    let talk = fold("claude", [
      '{"type":"assistant","message":{"content":[{"type":"text","text":"Controllo."}]},"session_id":"s"}',
    ])
    talk = applyRunnerLine(runnerById("claude"), talk, ev({ type: "content_block_start", index: 0 }), 0)
    talk = applyRunnerLine(runnerById("claude"), talk, delta("Ci sono due"), 0)
    expect(answerSoFar(talk)).toBe("Controllo.\n\nCi sono due")
  })
})

describe("Claude Code reading its messages from stdin", () => {
  test("asks for stream-json input and passes no message", () => {
    const { args } = turnCommand(runnerById("claude"), { bot, message: "ignorato", stdin: true })
    expect(args.slice(0, 6)).toEqual([
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      "--input-format",
      "stream-json",
    ])
    expect(args).not.toContain("--")
    expect(args).not.toContain("ignorato")
  })
})
