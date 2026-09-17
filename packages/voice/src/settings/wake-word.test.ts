import { describe, expect, test } from "bun:test"
import { matchesWakeWord } from "./wake-word"

describe("settings/wake-word - matchesWakeWord", () => {
  const wakeWord = "hei nik"

  test("triggers on canonical and common speech-to-text misrecognitions", () => {
    // Exact canonical phrase
    expect(matchesWakeWord("hei nik", wakeWord)).toEqual({
      matched: true,
      remainder: "",
    })

    // Italian phonetic and spelling ASR variations
    expect(matchesWakeWord("ehi nik", wakeWord)).toEqual({
      matched: true,
      remainder: "",
    })

    expect(matchesWakeWord("hey nick", wakeWord)).toEqual({
      matched: true,
      remainder: "",
    })

    expect(matchesWakeWord("ei nik", wakeWord)).toEqual({
      matched: true,
      remainder: "",
    })

    expect(matchesWakeWord("ehi nick", wakeWord)).toEqual({
      matched: true,
      remainder: "",
    })
  })

  test("extracts what remains of the utterance following the wake word", () => {
    const res = matchesWakeWord("hei nik apri il browser", wakeWord)
    expect(res).toEqual({
      matched: true,
      remainder: "apri il browser",
    })

    const res2 = matchesWakeWord("ehi nick crea una nuova sessione", wakeWord)
    expect(res2).toEqual({
      matched: true,
      remainder: "crea una nuova sessione",
    })

    const resWithFillers = matchesWakeWord("ehm ehi nik per favore apri la plancia", wakeWord)
    expect(resWithFillers.matched).toBe(true)
    expect(resWithFillers.remainder).toBe("apri la plancia")
  })

  test("does NOT trigger when wake-phrase appears embedded inside a longer word", () => {
    // Substring inside larger Italian words or invented compounds must not fire
    expect(matchesWakeWord("nikopolis", wakeWord).matched).toBe(false)
    expect(matchesWakeWord("disobbedienik", wakeWord).matched).toBe(false)
    expect(matchesWakeWord("scheinik", wakeWord).matched).toBe(false)
    expect(matchesWakeWord("heirloom nik", wakeWord).matched).toBe(false)
    expect(matchesWakeWord("parola con nikopolis dentro", wakeWord).matched).toBe(false)
  })

  test("returns not matched on unrelated utterances or empty inputs", () => {
    expect(matchesWakeWord("", wakeWord).matched).toBe(false)
    expect(matchesWakeWord("chiudi il pannello", wakeWord).matched).toBe(false)
    expect(matchesWakeWord("buongiorno a tutti", wakeWord).matched).toBe(false)
  })

  test("supports custom user-configured wake words", () => {
    const customWake = "jarvis"
    expect(matchesWakeWord("jarvis apri il terminale", customWake)).toEqual({
      matched: true,
      remainder: "apri il terminale",
    })

    expect(matchesWakeWord("jarvisiano", customWake).matched).toBe(false)
  })
})

describe("the name has to open the sentence", () => {
  test("a name in the middle of a sentence is not an address", () => {
    // What a television or a conversation in the room sounds like.
    expect(matchesWakeWord("domani il nick della squadra sarà annunciato", "nik").matched).toBe(false)
    expect(matchesWakeWord("secondo nick il mercato è in crescita", "nik").matched).toBe(false)
  })

  test("«ei» and its spellings may come first, nothing else", () => {
    expect(matchesWakeWord("nik apri il browser", "nik")).toEqual({ matched: true, remainder: "apri il browser" })
    expect(matchesWakeWord("ehi nik apri il browser", "nik")).toEqual({ matched: true, remainder: "apri il browser" })
    for (const heard of ["ei nik", "hei nik", "hey nick", "ehi, Nick", "Nick,"]) {
      expect(matchesWakeWord(`${heard} apri il browser`, "nik")).toEqual({
        matched: true,
        remainder: "apri il browser",
      })
    }
    for (const heard of ["e nik,", "eh nik.", "E Nick,"]) {
      expect(matchesWakeWord(`${heard} apri il browser`, "nik")).toEqual({
        matched: true,
        remainder: "apri il browser",
      })
    }
    for (const heard of ["ok nik", "ciao nik", "senti nik", "scusa nik"]) {
      expect(matchesWakeWord(`${heard} apri il browser`, "nik").matched).toBe(false)
    }
    expect(matchesWakeWord("il mio amico nik apri il browser", "nik").matched).toBe(false)
  })
})

describe("the fixed phrase, «ei nik», as the recogniser writes it", () => {
  const phrase = "ei nik"

  test("the common transcriptions all call it", () => {
    for (const heard of ["ei nik", "ehi nik", "hey nik", "hei nik", "ei nick", "ehi nick", "Hey, Nick!", "Ehi Nik,"]) {
      expect(matchesWakeWord(`${heard} apri il browser`, phrase)).toEqual({
        matched: true,
        remainder: "apri il browser",
      })
    }
  })

  test("said quickly and written as one word, it still does", () => {
    expect(matchesWakeWord("einik apri il browser", phrase)).toEqual({ matched: true, remainder: "apri il browser" })
    expect(matchesWakeWord("heynick, apri il browser", phrase)).toEqual({ matched: true, remainder: "apri il browser" })
  })

  test("the name alone, or the greeting alone, does not", () => {
    expect(matchesWakeWord("nik apri il browser", phrase).matched).toBe(false)
    expect(matchesWakeWord("ehi apri il browser", phrase).matched).toBe(false)
    expect(matchesWakeWord("il telegiornale ehi nik", phrase).matched).toBe(false)
    expect(matchesWakeWord("einikolaus", phrase).matched).toBe(false)
  })
})

describe("only the name itself", () => {
  test("words one letter away from it are not the name", () => {
    for (const heard of [
      "nì",
      "ni",
      "Nike",
      "niko",
      "nico",
      "mik",
      "nike apri il browser",
      "niko apri il browser",
      "ni apri il browser",
    ]) {
      expect(matchesWakeWord(heard, "nik").matched).toBe(false)
    }
  })
})

describe("«e nik» and «eh nik» from a television", () => {
  test("without a pause after the name, it is not a call, whatever follows", () => {
    for (const heard of [
      "E Nick ha detto che domani piove",
      "E Nick apre la porta",
      "eh Nik non c'era",
      "e nik apri il browser",
      "ehnik apri il browser",
    ]) {
      expect(matchesWakeWord(heard, "nik").matched).toBe(false)
    }
  })

  test("with a pause, or the name alone, it calls; «nik» and «ei nik» are unchanged", () => {
    expect(matchesWakeWord("e nik, che ore sono", "nik")).toEqual({ matched: true, remainder: "che ore sono" })
    expect(matchesWakeWord("E Nick. Apri il browser", "nik").matched).toBe(true)
    expect(matchesWakeWord("eh nik", "nik")).toEqual({ matched: true, remainder: "" })
    expect(matchesWakeWord("ehnik, apri il browser", "nik").matched).toBe(true)
    expect(matchesWakeWord("e nick", "nik")).toEqual({ matched: true, remainder: "" })
    expect(matchesWakeWord("ei nik ha finito la sessione 2?", "nik").matched).toBe(true)
    expect(matchesWakeWord("hey nick apre la porta", "nik").matched).toBe(true)
    expect(matchesWakeWord("nik che ore sono", "nik").matched).toBe(true)
  })
})
