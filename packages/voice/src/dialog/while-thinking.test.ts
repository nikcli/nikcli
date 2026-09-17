import { describe, expect, test } from "bun:test"
import { parseUtterance } from "../intent/parse"
import { firstWords, isSendHeld, triageWhileThinking } from "./while-thinking"

const heard = (text: string) => triageWhileThinking(parseUtterance(text), { typed: false }).action
const typed = (text: string) => triageWhileThinking(parseUtterance(text), { typed: true }).action

describe("dialog/while-thinking", () => {
  test("stop words stop, heard or typed", () => {
    for (const text of [
      "annulla",
      "Stop.",
      "basta",
      "fermati",
      "lascia stare",
      "annulla la richiesta",
      "ferma la domanda",
      "basta così nik",
      "interrompi pure",
      "lascia perdere la richiesta",
    ]) {
      expect(heard(text)).toBe("stop")
      expect(typed(text)).toBe("stop")
    }
  })

  test("a stop word opening a longer sentence is not a stop", () => {
    expect(heard("basta con le tasse sulla casa, dice il ministro")).toBe("hold")
  })

  test("a command the grammar knows is a request", () => {
    expect(heard("apri la tavolozza")).toBe("request")
    expect(heard("nuova sessione")).toBe("request")
  })

  test("a free sentence is held, however long or confident: the television talks in long sentences", () => {
    expect(heard("e adesso passiamo alle previsioni del tempo per domani su tutta la penisola")).toBe("hold")
    expect(heard("il governo ha approvato la legge di bilancio nella notte")).toBe("hold")
  })

  test("fillers are left alone", () => {
    for (const text of ["ok", "sì", "no", "mh", "va bene", "grazie", ""]) expect(heard(text)).toBe("ignore")
  })

  test("typed text is always meant", () => {
    expect(typed("quante sessioni ci sono")).toBe("request")
    expect(typed("no")).toBe("stop")
  })

  test("«invia questa» sends the held sentence; a bare «invia» does not", () => {
    for (const text of ["invia questa", "Invia questa.", "mandala", "manda questa frase"])
      expect(isSendHeld(text)).toBe(true)
    for (const text of ["invia", "invia il messaggio al pannello due"]) expect(isSendHeld(text)).toBe(false)
  })
})

describe("what reaches the console, and what a command needs", () => {
  test("a long sentence is named by its first words, not quoted whole", () => {
    expect(firstWords("il governo ha approvato nella notte la legge di bilancio con nuove misure")).toBe(
      "il governo ha approvato nella notte la legge di…",
    )
    expect(firstWords("apri il browser")).toBe("apri il browser")
  })

  test("while thinking, a command not addressed by name is held, not carried out", () => {
    const command = parseUtterance("chiudi il pannello due")
    expect(triageWhileThinking(command, { typed: false, named: false }).action).toBe("hold")
    expect(triageWhileThinking(command, { typed: false, named: true }).action).toBe("request")
    // Stopping is the exception: it undoes, and it is wanted at once.
    expect(triageWhileThinking(parseUtterance("annulla"), { typed: false, named: false }).action).toBe("stop")
  })
})
