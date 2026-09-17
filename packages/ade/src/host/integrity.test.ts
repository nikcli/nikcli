import { describe, expect, test } from "bun:test"
import { hasLowLabel } from "./integrity"

describe("hasLowLabel", () => {
  test("riconosce l'etichetta Low in italiano e in inglese", () => {
    expect(hasLowLabel("C:\\x BUILTIN\\Users:(F)\r\n    Etichetta obbligatoria\\Livello obbligatorio basso:(I)(OI)(CI)(NW)")).toBe(true)
    expect(hasLowLabel("C:\\x\n    Mandatory Label\\Low Mandatory Level:(OI)(CI)(NW)")).toBe(true)
  })

  test("Medium o nessuna etichetta non sono Low", () => {
    expect(hasLowLabel("    Etichetta obbligatoria\\Livello obbligatorio medio:(OI)(CI)(NW)")).toBe(false)
    expect(hasLowLabel("C:\\x BUILTIN\\Users:(F)")).toBe(false)
  })
})
