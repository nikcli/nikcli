import { describe, expect, test } from "bun:test"
import { pickBestVoice, createWebSpeechSpeaker, createFakeSpeaker } from "./speaker"

describe("pickBestVoice", () => {
  const mockVoices = [
    { name: "Microsoft Cosimo - Italian (Italy)", lang: "it-IT", default: false, localService: true, voiceURI: "cosimo" },
    { name: "Microsoft Elsa - Italian (Italy)", lang: "it-IT", default: false, localService: true, voiceURI: "elsa" },
    { name: "Microsoft Diego Online (Natural) - Italian (Italy)", lang: "it-IT", default: false, localService: false, voiceURI: "diego-online" },
    { name: "Microsoft Isabella Online (Natural) - Italian (Italy)", lang: "it-IT", default: false, localService: false, voiceURI: "isabella-online" },
    { name: "Google US English", lang: "en-US", default: true, localService: false, voiceURI: "google-en" },
  ] as unknown as SpeechSynthesisVoice[]

  test("prioritizza le voci neurali/naturali rispetto a quelle meccaniche legacy", () => {
    const picked = pickBestVoice(mockVoices, "it-IT")
    expect(picked).toBeDefined()
    // Deve aver preferito una voce naturale/online rispetto al primo Cosimo meccanico
    expect(picked!.name).toContain("Natural")
  })

  test("rispetta una voce preferita specificata dall'utente (es. diego o isabella)", () => {
    const isabella = pickBestVoice(mockVoices, "it-IT", "isabella")
    expect(isabella).toBeDefined()
    expect(isabella!.name).toContain("Isabella")

    const diego = pickBestVoice(mockVoices, "it-IT", "diego")
    expect(diego).toBeDefined()
    expect(diego!.name).toContain("Diego")
  })

  test("ripiega sulla prima voce della lingua corretta se non ci sono voci neurali", () => {
    const legacyOnly = [
      { name: "Microsoft Cosimo", lang: "it-IT" },
      { name: "Microsoft Elsa", lang: "it-IT" },
    ] as unknown as SpeechSynthesisVoice[]

    const picked = pickBestVoice(legacyOnly, "it-IT")
    expect(picked).toBeDefined()
    expect(picked!.name).toBe("Microsoft Cosimo")
  })

  test("restituisce undefined se non c'è nessuna voce per la lingua richiesta", () => {
    const picked = pickBestVoice(mockVoices, "fr-FR")
    expect(picked).toBeUndefined()
  })

  test("gestisce array vuoto in modo resiliente", () => {
    const picked = pickBestVoice([], "it-IT")
    expect(picked).toBeUndefined()
  })
})

describe("createWebSpeechSpeaker", () => {
  test("crea uno speaker con metodi speak e cancel", () => {
    const speaker = createWebSpeechSpeaker({ lang: "it-IT", preferredVoice: "diego" })
    expect(typeof speaker.speak).toBe("function")
    expect(typeof speaker.cancel).toBe("function")
  })
})

describe("createFakeSpeaker", () => {
  test("traccia le frasi pronunciate e permette di cancellarle", async () => {
    const fake = createFakeSpeaker()
    expect(fake.spoken).toEqual([])
    expect(fake.lastSpoken).toBeUndefined()

    await fake.speak("Prima frase")
    expect(fake.spoken).toEqual(["Prima frase"])
    expect(fake.lastSpoken).toBe("Prima frase")

    await fake.speak("Seconda frase")
    expect(fake.spoken).toEqual(["Prima frase", "Seconda frase"])
    expect(fake.lastSpoken).toBe("Seconda frase")

    fake.clear()
    expect(fake.spoken).toEqual([])
    expect(fake.lastSpoken).toBeUndefined()
  })
})
