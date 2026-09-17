import { describe, expect, test } from "bun:test"
import { normalizeAccents, normalizeUtterance, stripFillers, wordsToNumbers } from "./normalize"

describe("normalizeUtterance", () => {
  describe("accents and diacritics", () => {
    test("folds standard accented vowels into unaccented equivalents", () => {
      expect(normalizeAccents("perché")).toBe("perche")
      expect(normalizeAccents("qualità")).toBe("qualita")
      expect(normalizeAccents("così")).toBe("cosi")
      expect(normalizeAccents("può")).toBe("puo")
      expect(normalizeAccents("più")).toBe("piu")
      expect(normalizeAccents("è")).toBe("e")
    })

    test("handles vowel followed by apostrophe", () => {
      expect(normalizeAccents("perche'")).toBe("perche")
      expect(normalizeAccents("cioe'")).toBe("cioe")
      expect(normalizeAccents("e'")).toBe("e")
      expect(normalizeAccents("si'")).toBe("si")
    })
  })

  describe("wordsToNumbers", () => {
    test("converts cardinal numbers 0 to 20", () => {
      expect(wordsToNumbers("zero uno due tre quattro cinque")).toBe("0 1 2 3 4 5")
      expect(wordsToNumbers("sei sette otto nove dieci")).toBe("6 7 8 9 10")
      expect(wordsToNumbers("undici dodici tredici quattordici quindici")).toBe("11 12 13 14 15")
      expect(wordsToNumbers("sedici diciassette diciotto diciannove venti")).toBe("16 17 18 19 20")
    })

    test("converts tens and compound numbers up to 50", () => {
      expect(wordsToNumbers("trenta quaranta cinquanta")).toBe("30 40 50")
      expect(wordsToNumbers("ventuno trentadue quarantacinque")).toBe("21 32 45")
    })

    test("converts ordinal numbers both masculine and feminine", () => {
      expect(wordsToNumbers("primo prima secondo seconda terzo terza")).toBe("1 1 2 2 3 3")
      expect(wordsToNumbers("quarto quinta decimo ventesimo")).toBe("4 5 10 20")
    })

    test("leaves non-numeric words untouched", () => {
      expect(wordsToNumbers("chiudi il pannello")).toBe("chiudi il pannello")
    })
  })

  describe("stripFillers", () => {
    test("removes multi-word polite filler phrases", () => {
      expect(stripFillers("chiudi per favore il pannello")).toBe("chiudi il pannello")
      expect(stripFillers("per cortesia apri la sessione")).toBe("apri la sessione")
    })

    test("removes conversational filler words without affecting substrings", () => {
      expect(stripFillers("ehm allora dai apri la finestra")).toBe("apri la finestra")
      expect(stripFillers("cioe dunque mostrami il codice")).toBe("mostrami il codice")
    })
  })

  describe("full pipeline normalizeUtterance", () => {
    test("normalizes 'Chiudi il pannello tre, per favore!'", () => {
      expect(normalizeUtterance("Chiudi il pannello tre, per favore!")).toBe("chiudi il pannello 3")
    })

    test("normalizes 'Ehm, allora apri la seconda sessione...'", () => {
      expect(normalizeUtterance("Ehm, allora apri la seconda sessione...")).toBe("apri la 2 sessione")
    })

    test("normalizes 'Cioè, dai, vai a dormire'", () => {
      expect(normalizeUtterance("Cioè, dai, vai a dormire")).toBe("vai a dormire")
    })

    test("normalizes 'Sì, conferma per cortesia'", () => {
      expect(normalizeUtterance("Sì, conferma per cortesia")).toBe("si conferma")
    })

    test("handles empty and whitespace strings gracefully", () => {
      expect(normalizeUtterance("")).toBe("")
      expect(normalizeUtterance("    ")).toBe("")
    })
  })
})
