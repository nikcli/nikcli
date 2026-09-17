import { describe, expect, test } from "bun:test"
import { AGENTS } from "../session-new/agents"
import { listProjectsFrom, resolveAgentId, resolveProject, spokenKey } from "./resolve"

describe("resolveAgentId", () => {
  test("accetta l'id del catalogo", () => {
    expect(resolveAgentId("claude-code", AGENTS)).toBe("claude-code")
  })

  /*
   * Nessuno dice «claude trattino code» a voce: il trascrittore scrive
   * l'etichetta, l'utente dice il nome del comando, e devono valere entrambi.
   */
  test("accetta l'etichetta, il comando e come si dicono a voce", () => {
    expect(resolveAgentId("Claude Code", AGENTS)).toBe("claude-code")
    expect(resolveAgentId("claude", AGENTS)).toBe("claude-code")
    expect(resolveAgentId("  CLAUDE   CODE  ", AGENTS)).toBe("claude-code")
    expect(resolveAgentId("agy", AGENTS)).toBe("agy")
    expect(resolveAgentId("Kimi", AGENTS)).toBe("kimi")
    expect(resolveAgentId("open code", AGENTS)).toBe("opencode")
  })

  test("ignora gli accenti che la dettatura aggiunge", () => {
    expect(resolveAgentId("Kìmi", AGENTS)).toBe("kimi")
  })

  /*
   * Il fallimento più caro non è «non ho capito»: è avviare un agente diverso
   * da quello chiesto e riferire che è andato tutto bene.
   */
  test("rifiuta un agente che non esiste, elencando quelli veri", () => {
    expect(() => resolveAgentId("copilot", AGENTS)).toThrow(/Non conosco l'agente «copilot»/)
    expect(() => resolveAgentId("copilot", AGENTS)).toThrow(/Claude Code/)
    expect(() => resolveAgentId("copilot", AGENTS)).toThrow(/OpenCode/)
  })

  test("rifiuta una stringa vuota", () => {
    expect(() => resolveAgentId("   ", AGENTS)).toThrow(/Non conosco l'agente/)
  })

  test("un prefisso ambiguo è un rifiuto, non una scelta a caso", () => {
    const ambiguous = [
      { id: "alfa-uno", label: "Alfa Uno", command: "alfauno" },
      { id: "alfa-due", label: "Alfa Due", command: "alfadue" },
    ]
    expect(() => resolveAgentId("alfa", ambiguous)).toThrow(/Non conosco l'agente «alfa»/)
  })
})

describe("listProjectsFrom", () => {
  test("mette per primo il progetto aperto ed è l'unico con isOpen", () => {
    const list = listProjectsFrom(
      [
        { root: "C:/altro", name: "altro" },
        { root: "C:/repo", name: "nikcli" },
      ],
      { root: "C:/repo", name: "nikcli" },
    )

    expect(list.map((p) => p.name)).toEqual(["nikcli", "altro"])
    expect(list.filter((p) => p.isOpen).map((p) => p.name)).toEqual(["nikcli"])
  })

  /*
   * Lo stesso progetto arriva nella lista scritto in due modi: con le barre
   * rovesce dalla shell e con quelle dritte dalla sidebar. È un progetto solo.
   */
  test("deduplica per percorso normalizzato, non per stringa", () => {
    const list = listProjectsFrom(
      [
        { root: "C:\\Users\\x\\repo\\", name: "repo (shell)" },
        { root: "c:/users/x/repo", name: "repo (sidebar)" },
      ],
      undefined,
    )

    expect(list).toHaveLength(1)
    expect(list[0]!.name).toBe("repo (shell)")
  })

  test("il progetto aperto vince la deduplica anche se scritto diversamente", () => {
    const list = listProjectsFrom(
      [{ root: "C:\\Users\\x\\repo", name: "repo" }],
      { root: "C:/Users/x/repo", name: "repo" },
    )

    expect(list).toHaveLength(1)
    expect(list[0]!.isOpen).toBe(true)
  })

  test("senza progetto aperto nessuno è aperto", () => {
    const list = listProjectsFrom([{ root: "C:/repo", name: "nikcli" }], undefined)
    expect(list.every((p) => !p.isOpen)).toBe(true)
  })
})

describe("resolveProject", () => {
  const projects = [
    { name: "nikcli", root: "C:/Users/x/nikcli", isOpen: true },
    { name: "sito web", root: "C:/Users/x/sito-web", isOpen: false },
  ]

  test("trova per nome, anche detto male", () => {
    expect(resolveProject("nikcli", projects).root).toBe("C:/Users/x/nikcli")
    expect(resolveProject("NikCLI", projects).root).toBe("C:/Users/x/nikcli")
    expect(resolveProject("sitoweb", projects).root).toBe("C:/Users/x/sito-web")
  })

  test("trova per radice, con le barre in un verso o nell'altro", () => {
    expect(resolveProject("C:\\Users\\x\\nikcli", projects).name).toBe("nikcli")
    expect(resolveProject("c:/users/x/nikcli/", projects).name).toBe("nikcli")
  })

  test("trova per ultima cartella della radice", () => {
    expect(resolveProject("sito-web", projects).name).toBe("sito web")
  })

  test("rifiuta un progetto sconosciuto elencando quelli in lista", () => {
    expect(() => resolveProject("contabilità", projects)).toThrow(/Non conosco il progetto/)
    expect(() => resolveProject("contabilità", projects)).toThrow(/nikcli, sito web/)
  })

  test("lo dice quando la lista è vuota, invece di elencare il nulla", () => {
    expect(() => resolveProject("nikcli", [])).toThrow(/non ho nessun progetto in elenco/)
  })
})

describe("spokenKey", () => {
  test("appiattisce maiuscole, spazi, trattini e accenti", () => {
    expect(spokenKey("  Claude-Code ")).toBe("claudecode")
    expect(spokenKey("Gemini CLI")).toBe("geminicli")
    expect(spokenKey("perché_no")).toBe("percheno")
  })
})
