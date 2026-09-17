import { describe, expect, test } from "bun:test"
import {
  agentDir,
  agentHome,
  createArgs,
  editedAgentFile,
  joinPrompt,
  splitPrompt,
  globalConfigDir,
  identifierFor,
  identifierFromPath,
  isLegalIdentifier,
  launchArgs,
  parseAgentFile,
  parseCreatedPath,
  parseModelList,
  readAgentFile,
  serializeAgentFile,
} from "./nikcli"

describe("dove nikcli tiene gli agenti", () => {
  /*
   * `--path X` writes `X/agent/<name>.md`: the flag names the configuration
   * root, not the agent directory. Passing the agent directory produces
   * `agent/agent/…`, which nikcli's recursive glob still finds — so the
   * mistake is invisible until someone looks at the tree.
   */
  test("il progetto usa .nikcli, il globale la cartella stessa", () => {
    expect(agentHome("/p", "project")).toBe("/p/.nikcli")
    expect(agentHome("/cfg", "global")).toBe("/cfg")
    expect(agentDir("/p", "project")).toBe("/p/.nikcli/agent")
    expect(agentDir("/cfg", "global")).toBe("/cfg/agent")
  })

  test("la cartella globale segue la convenzione della piattaforma", () => {
    expect(globalConfigDir("C:/Users/x", "windows")).toBe("C:/Users/x/AppData/Roaming/nikcli")
    expect(globalConfigDir("/home/x", "posix")).toBe("/home/x/.config/nikcli")
  })
})

describe("createArgs", () => {
  /*
   * All four flags together or none of it works: `agent create` decides it is
   * non-interactive by checking that every one of them is present, and with
   * one missing it opens a prompt on a terminal nobody is attached to and
   * waits there until the pane is closed.
   */
  test("passa sempre tutti e quattro i flag che rendono il comando non interattivo", () => {
    const args = createArgs({ home: "/p/.nikcli", description: "Revisiona i PR", mode: "primary" })
    expect(args).toEqual([
      "agent",
      "create",
      "--path",
      "/p/.nikcli",
      "--description",
      "Revisiona i PR",
      "--mode",
      "primary",
      "--tools",
      "",
    ])
  })

  /* The empty string is the documented "all of them"; dropping the flag would
     make the command interactive instead. */
  test("nessuno strumento scelto significa tutti, non nessun flag", () => {
    expect(createArgs({ home: "/h", description: "d", mode: "all" })).toContain("--tools")
    const some = createArgs({ home: "/h", description: "d", mode: "all", tools: ["read", "bash"] })
    expect(some[some.indexOf("--tools") + 1]).toBe("read,bash")
  })
})

describe("parseCreatedPath", () => {
  test("prende il percorso che il comando ha stampato", () => {
    expect(parseCreatedPath("C:/p/.nikcli/agent/revisore.md\n")).toBe("C:/p/.nikcli/agent/revisore.md")
  })

  /* The process logs too, and an inherited noisy environment can put a line in
     front of the answer. */
  test("ignora il rumore prima del percorso", () => {
    expect(parseCreatedPath("INFO qualcosa\n/p/agent/a.md")).toBe("/p/agent/a.md")
  })

  test("un'uscita che non contiene un percorso non è un successo", () => {
    expect(parseCreatedPath("Error: Agent file already exists")).toBeUndefined()
    expect(parseCreatedPath("")).toBeUndefined()
  })
})

describe("identificativi", () => {
  test("il nome del file è il nome che nikcli conosce", () => {
    expect(identifierFromPath("C:/p/.nikcli/agent/revisore-senior.md")).toBe("revisore-senior")
  })

  test("rifiuta ciò che non si può passare a --agent", () => {
    expect(isLegalIdentifier("revisore")).toBe(true)
    expect(isLegalIdentifier("revisore-2")).toBe(true)
    expect(isLegalIdentifier("Revisore")).toBe(false)
    expect(isLegalIdentifier("revisore senior")).toBe(false)
    expect(isLegalIdentifier("")).toBe(false)
  })

  /* Two bots called "Revisore" are two bots: the second must not take the
     first one's file, and `agent create` refuses to overwrite anyway. */
  test("un nome già preso prende un suffisso", () => {
    expect(identifierFor("Revisore")).toBe("revisore")
    expect(identifierFor("Revisore", ["revisore"])).toBe("revisore-2")
    expect(identifierFor("Perché no", [])).toBe("perche-no")
  })
})

describe("parseAgentFile", () => {
  test("legge le chiavi semplici e il corpo", () => {
    const parsed = parseAgentFile(
      ["---", "description: quando serve", "mode: primary", "---", "", "Sei un revisore."].join("\n"),
    )
    expect(parsed.front.values["description"]).toBe("quando serve")
    expect(parsed.front.values["mode"]).toBe("primary")
    expect(parsed.prompt).toBe("Sei un revisore.")
  })

  /* gray-matter folds a long description onto continuation lines. Read as a
     bare key with an empty value, the roster showed a blank line for the one
     thing that says what a bot is for. */
  test("ricompone uno scalare piegato", () => {
    const parsed = parseAgentFile(
      ["---", "description: >-", "  prima parte", "  seconda parte", "mode: all", "---", "corpo"].join("\n"),
    )
    expect(parsed.front.values["description"]).toBe("prima parte seconda parte")
    expect(parsed.front.values["mode"]).toBe("all")
  })

  test("legge la mappa degli strumenti disattivati", () => {
    const parsed = parseAgentFile(
      ["---", "mode: all", "tools:", "  bash: false", "  write: false", "---", "corpo"].join("\n"),
    )
    expect(parsed.front.maps["tools"]).toEqual({ bash: false, write: false })
  })

  test("un file senza frontmatter è tutto prompt", () => {
    const parsed = parseAgentFile("Solo il corpo.")
    expect(parsed.prompt).toBe("Solo il corpo.")
    expect(parsed.front.values).toEqual({})
  })

  test("i ritorni a capo di Windows non cambiano la lettura", () => {
    const parsed = parseAgentFile("---\r\ndescription: x\r\nmode: all\r\n---\r\ncorpo")
    expect(parsed.front.values["description"]).toBe("x")
    expect(parsed.prompt).toBe("corpo")
  })
})

describe("serializeAgentFile", () => {
  /*
   * The values come from a form, so they can contain a colon, a `#`, or start
   * with a `>` — each of which turns an unquoted YAML scalar into something
   * else, and one of which makes the file unparseable and the bot vanish from
   * nikcli's list with no error anywhere in ADE.
   */
  test("scrive un file che si rilegge da solo, due punti compresi", () => {
    const text = serializeAgentFile({
      description: "Revisore: PR e issue",
      mode: "primary",
      model: "anthropic/claude-opus-5",
      prompt: "Sei un revisore.",
    })
    const parsed = parseAgentFile(text)
    expect(parsed.front.values["description"]).toBe("Revisore: PR e issue")
    expect(parsed.front.values["model"]).toBe("anthropic/claude-opus-5")
    expect(parsed.prompt).toBe("Sei un revisore.")
  })

  test("gli strumenti disattivati sopravvivono al giro", () => {
    const text = serializeAgentFile({
      description: "d",
      mode: "all",
      disabledTools: ["bash", "write"],
      prompt: "p",
    })
    expect(parseAgentFile(text).front.maps["tools"]).toEqual({ bash: false, write: false })
  })
})

describe("la faccia scelta", () => {
  test("va nel file come chiave propria e torna indietro", () => {
    const text = serializeAgentFile({
      description: "Revisiona",
      mode: "primary",
      avatar: "hex/red",
      prompt: "Sei un revisore.",
    })
    expect(text).toContain('avatar: "hex/red"')
    const bot = readAgentFile({ path: "/p/.nikcli/agent/revisore.md", scope: "project", text })
    expect(bot.avatar).toBe("hex/red")
  })

  test("si cambia e si toglie senza toccare il resto", () => {
    const text = serializeAgentFile({
      description: "Revisiona",
      mode: "primary",
      avatar: "hex/red",
      prompt: "Sei un revisore.",
    })
    const changed = editedAgentFile(text, { avatar: "drop/blue" })
    expect(changed).toContain('avatar: "drop/blue"')
    expect(changed).not.toContain("hex/red")
    const cleared = editedAgentFile(text, { avatar: undefined })
    expect(cleared).not.toContain("avatar:")
    expect(editedAgentFile(text, { description: "Altro" })).toContain('avatar: "hex/red"')
  })
})

describe("il motore scelto", () => {
  test("nikcli non si scrive, gli altri sì, e tornano indietro", () => {
    expect(serializeAgentFile({ description: "d", mode: "primary", runner: "nikcli", prompt: "p" })).not.toContain(
      "runner:",
    )
    const text = serializeAgentFile({
      description: "d",
      mode: "primary",
      runner: "claude",
      model: "sonnet",
      prompt: "p",
    })
    expect(text).toContain('runner: "claude"')
    expect(readAgentFile({ path: "/p/.nikcli/agent/x.md", scope: "project", text }).runner).toBe("claude")
  })

  test("si cambia e si toglie senza toccare il resto", () => {
    const text = serializeAgentFile({
      description: "d",
      mode: "primary",
      runner: "codex",
      avatar: "hex/red",
      prompt: "p",
    })
    expect(editedAgentFile(text, { runner: "claude" })).toContain('runner: "claude"')
    const cleared = editedAgentFile(text, { runner: undefined })
    expect(cleared).not.toContain("runner:")
    expect(cleared).toContain('avatar: "hex/red"')
    expect(editedAgentFile(text, { description: "Altro" })).toContain('runner: "codex"')
  })
})

describe("readAgentFile", () => {
  test("un file letto è un bot con tutto quello che serve per mostrarlo", () => {
    const bot = readAgentFile({
      path: "/p/.nikcli/agent/revisore.md",
      scope: "project",
      text: serializeAgentFile({
        description: "Quando serve una revisione",
        mode: "primary",
        model: "a/b",
        disabledTools: ["bash"],
        prompt: "Sei un revisore.",
      }),
    })
    expect(bot).toEqual({
      identifier: "revisore",
      path: "/p/.nikcli/agent/revisore.md",
      scope: "project",
      description: "Quando serve una revisione",
      mode: "primary",
      model: "a/b",
      prompt: "Sei un revisore.",
      disabledTools: ["bash"],
    })
  })

  test("un modo sconosciuto vale come «all», non fa sparire il bot", () => {
    const bot = readAgentFile({
      path: "/a/x.md",
      scope: "global",
      text: "---\nmode: qualcosa\n---\ncorpo",
    })
    expect(bot.mode).toBe("all")
  })
})

describe("persona e obiettivi", () => {
  /*
   * nikcli's agent file has one place for instructions — the body, which is
   * the system prompt — and no concept of goals. So objectives live in the
   * prompt under a known heading, and this is the round trip that lets ADE
   * show them in their own field without inventing a second file.
   */
  test("gli obiettivi tornano indietro come li abbiamo scritti", () => {
    const prompt = joinPrompt({
      persona: "Sei un revisore.",
      objectives: ["Trova i rischi", "Non riscrivere il codice"],
    })
    expect(splitPrompt(prompt)).toEqual({
      persona: "Sei un revisore.",
      objectives: ["Trova i rischi", "Non riscrivere il codice"],
    })
  })

  test("senza obiettivi il file non ha una sezione vuota", () => {
    expect(joinPrompt({ persona: "Sei un revisore.", objectives: [] })).toBe("Sei un revisore.")
    expect(joinPrompt({ persona: "x", objectives: ["  ", ""] })).toBe("x")
  })

  test("un prompt scritto a mano senza intestazione è tutto persona", () => {
    expect(splitPrompt("Sei un revisore.\nFai attenzione.")).toEqual({
      persona: "Sei un revisore.\nFai attenzione.",
      objectives: [],
    })
  })

  /*
   * The file is meant to be editable by hand. A sentence someone wrote under
   * the heading is not a bullet, and dropping it on the next save would be a
   * loss caused by opening a panel — so it comes back as part of the persona
   * rather than disappearing.
   */
  test("una frase sotto l'intestazione non si perde", () => {
    const parts = splitPrompt("Sei un revisore.\n\n## Obiettivi\nNota sciolta\n- Trova i rischi")
    expect(parts.objectives).toEqual(["Trova i rischi"])
    expect(parts.persona).toContain("Nota sciolta")
  })

  test("accetta i trattini che la gente usa davvero", () => {
    const parts = splitPrompt("p\n\n## Obiettivi\n* uno\n• due\n- tre")
    expect(parts.objectives).toEqual(["uno", "due", "tre"])
  })
})

describe("editedAgentFile", () => {
  const original = serializeAgentFile({
    description: "Quando serve una revisione",
    mode: "primary",
    model: "a/b",
    effort: "high",
    disabledTools: ["bash"],
    prompt: joinPrompt({ persona: "Sei un revisore.", objectives: ["Trova i rischi"] }),
  })

  test("cambia una cosa sola e lascia stare il resto", () => {
    const bot = readAgentFile({
      path: "/a/r.md",
      scope: "project",
      text: editedAgentFile(original, { effort: "minimal" }),
    })
    expect(bot.effort).toBe("minimal")
    expect(bot.model).toBe("a/b")
    expect(bot.description).toBe("Quando serve una revisione")
    expect(bot.disabledTools).toEqual(["bash"])
    expect(splitPrompt(bot.prompt).objectives).toEqual(["Trova i rischi"])
  })

  /*
   * `agent create --model` chooses the model that *writes* the agent and never
   * records one, so a bot created through nikcli comes back pinned to nothing
   * and this is what pins it. Rewritten whole rather than patched, because a
   * regex edit on YAML is how you end up with two `model:` keys.
   */
  test("fissare il modello non lo duplica", () => {
    const bare = serializeAgentFile({ description: "d", mode: "primary", prompt: "p" })
    const pinned = editedAgentFile(bare, { model: "openai/gpt-5" })
    expect((pinned.match(/^model:/gm) ?? []).length).toBe(1)
    expect(parseAgentFile(pinned).front.values["model"]).toBe("openai/gpt-5")
    expect(parseAgentFile(pinned).prompt).toBe("p")
  })

  test("sostituire gli obiettivi non tocca la persona", () => {
    const text = editedAgentFile(original, { objectives: ["Altro"] })
    expect(splitPrompt(parseAgentFile(text).prompt)).toEqual({
      persona: "Sei un revisore.",
      objectives: ["Altro"],
    })
  })

  /*
   * nikcli applies `variant` only when the agent has a configured model.
   * Leaving it behind on a bot whose model was cleared would record a setting
   * nothing reads — and would come back the day a model is chosen again,
   * which is not what clearing it meant.
   */
  test("togliere il modello porta via anche lo sforzo", () => {
    const text = editedAgentFile(original, { model: undefined })
    const bot = readAgentFile({ path: "/a/r.md", scope: "global", text })
    expect(bot.model).toBeUndefined()
    expect(bot.effort).toBeUndefined()
  })

  /*
   * The schema nikcli accepts is much wider than what ADE offers. Rewriting
   * the file without the rest would delete settings ADE never showed — an
   * invisible loss caused by opening a panel.
   */
  test("le chiavi che ADE non mostra sopravvivono a una riscrittura", () => {
    const handWritten = [
      "---",
      'description: "d"',
      "mode: all",
      'model: "a/b"',
      "temperature: 0.2",
      'advisor: "anthropic/claude-opus-5"',
      "---",
      "corpo",
    ].join("\n")

    const rewritten = editedAgentFile(handWritten, { description: "nuova" })
    const front = parseAgentFile(rewritten).front.values
    expect(front["temperature"]).toBe("0.2")
    expect(front["advisor"]).toBe("anthropic/claude-opus-5")
    expect(front["description"]).toBe("nuova")
  })
})

describe("launchArgs", () => {
  /* The bare `nikcli` command is the TUI and it takes `--agent`, so a bot
     opens as a real interactive session in a pane. */
  test("apre una sessione come quel bot", () => {
    expect(launchArgs("revisore")).toEqual(["--agent", "revisore"])
  })

  /* Only when the bot pins one: passing nikcli's own default back to it is a
     way to break the day the default changes. */
  test("il modello si passa solo se il bot ne fissa uno", () => {
    expect(launchArgs("revisore", "a/b")).toEqual(["--agent", "revisore", "--model", "a/b"])
  })
})

describe("parseModelList", () => {
  test("una riga per modello, nel formato provider/modello", () => {
    expect(parseModelList("anthropic/claude-opus-5\nopenai/gpt-5\n")).toEqual([
      "anthropic/claude-opus-5",
      "openai/gpt-5",
    ])
  })

  test("scarta tutto ciò che non è un identificativo di modello", () => {
    expect(parseModelList('Models cache refreshed\n{\n  "cost": 1\n}\nx/y')).toEqual(["x/y"])
  })

  test("non ripete un modello elencato due volte", () => {
    expect(parseModelList("a/b\na/b")).toEqual(["a/b"])
  })
})
