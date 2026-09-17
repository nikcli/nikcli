import { describe, expect, test } from "bun:test"
import { replySpeech, summariseForSpeech, type SpeakableLine } from "./reply"

const step = (text: string): SpeakableLine => ({ kind: "step", text })
const shell = (text: string): SpeakableLine => ({ kind: "shell", text })
const diff = (text: string): SpeakableLine => ({ kind: "diff", text })

describe("summariseForSpeech", () => {
  test("legge la prosa dell'agente, non l'impalcatura attorno", () => {
    const spoken = summariseForSpeech([
      shell("$ bun test packages/voice"),
      step("─────────────────────────"),
      step("Ho corretto il parser: mancava il caso della riga vuota."),
      step("  ⠋ "),
    ])

    expect(spoken).toBe("Ho corretto il parser: mancava il caso della riga vuota.")
  })

  /*
   * Un diff letto ad alta voce è peggio del silenzio: è una sequenza di
   * simboli e numeri di riga che nessuno può seguire con le orecchie.
   */
  test("non legge mai un diff né un comando di shell", () => {
    const spoken = summariseForSpeech([shell("git diff"), diff("-  const a = 1"), diff("+  const a = 2")])

    expect(spoken).toBeUndefined()
  })

  test("salta i blocchi di codice, anche se la prosa li circonda", () => {
    const spoken = summariseForSpeech([
      step("Ecco la funzione:"),
      step("```ts"),
      step("export const x = 1"),
      step("```"),
      step("È già esportata."),
    ])

    expect(spoken).toBe("Ecco la funzione: È già esportata.")
  })

  /*
   * La fence può arrivare su una riga che il filtro dei kind avrebbe scartato.
   * Se il conteggio non la vedesse, tutto il codice dopo verrebbe letto.
   */
  test("una fence aperta su una riga scartata chiude comunque il codice", () => {
    const spoken = summariseForSpeech([shell("```"), step("const segreto = 42"), shell("```"), step("Fatto.")])

    expect(spoken).toBe("Fatto.")
  })

  test("gli errori vengono detti come errori", () => {
    const spoken = summariseForSpeech([{ kind: "error", text: "il file non esiste" }])
    expect(spoken).toBe("Errore: il file non esiste")
  })

  test("una sequenza di escape non viene pronunciata", () => {
    const spoken = summariseForSpeech([step("\x1b[32mTutto verde\x1b[0m")])
    expect(spoken).toBe("Tutto verde")
  })

  /*
   * Il pezzo che conta è in fondo: un agente racconta come ci arriva e poi
   * conclude. Tagliare dall'inizio significherebbe leggere la premessa e
   * fermarsi prima della risposta.
   */
  test("con troppa roba tiene la fine, e comincia da una frase intera", () => {
    const spoken = summariseForSpeech(
      [
        step("Ho guardato il primo file. Non c'era niente di strano lì dentro."),
        step("Poi ho guardato il secondo. La causa è un indice fuori intervallo."),
      ],
      { maxChars: 60 },
    )!

    expect(spoken.length).toBeLessThanOrEqual(60)
    expect(spoken).toBe("La causa è un indice fuori intervallo.")
  })

  test("una frase sola più lunga del budget viene tagliata su una parola", () => {
    const spoken = summariseForSpeech([step("a".repeat(30) + " " + "b".repeat(30))], {
      maxChars: 40,
    })!

    expect(spoken.length).toBeLessThanOrEqual(40)
    expect(spoken.startsWith("a")).toBe(false)
  })

  test("niente da dire resta niente da dire", () => {
    expect(summariseForSpeech([])).toBeUndefined()
    expect(summariseForSpeech([step("   "), step("━━━━"), step("···")])).toBeUndefined()
  })
})

/*
 * Il silenzio è il modo peggiore di fallire: un assistente che non dice niente
 * quando l'agente non ha prodotto niente è indistinguibile da uno rotto, e
 * l'utente resta ad ascoltare una stanza vuota.
 */
describe("replySpeech", () => {
  test("legge la risposta quando c'è", () => {
    expect(replySpeech({ lines: [step("Fatto, erano due righe.")], reason: "settled" })).toBe("Fatto, erano due righe.")
  })

  test("dice che non è arrivato niente invece di tacere", () => {
    expect(replySpeech({ lines: [], reason: "silent" })).toBe("Non ho ricevuto risposta.")
  })

  test("un agente ancora al lavoro viene detto tale, con quello che ha già prodotto", () => {
    const spoken = replySpeech({ lines: [step("Sto compilando.")], reason: "timeout" })!
    expect(spoken).toContain("Sto compilando.")
    expect(spoken).toContain("Sta ancora lavorando")
  })

  test("un errore senza prosa leggibile viene comunque annunciato", () => {
    expect(replySpeech({ lines: [diff("-x")], reason: "error" })).toBe("La sessione ha segnalato un errore.")
  })

  test("ha finito senza dire niente di leggibile, e lo dice", () => {
    expect(replySpeech({ lines: [diff("+y")], reason: "settled" })).toBe(
      "Ha finito, ma non ha lasciato una risposta da leggere.",
    )
  })

  /*
   * Questi due tacciono apposta: l'utente è andato avanti, o il pannello non
   * c'è più. Parlarci sopra sarebbe rumore.
   */
  test("interrotto o sparito non parla", () => {
    expect(replySpeech({ lines: [step("a")], reason: "aborted" })).toBeUndefined()
    expect(replySpeech({ lines: [], reason: "gone" })).toBeUndefined()
  })
})
