import { describe, expect, test } from "bun:test"
import { REPLY_VOICES } from "./model"
import { REPLY_VOICE_CHOICES } from "./reply-voices"

describe("settings/reply-voices", () => {
  test("D19: Maschile is Ugo and comes first, Femminile is Paola, and every voice in the model is offered", () => {
    expect(REPLY_VOICE_CHOICES[0]).toMatchObject({ value: "ugo", title: "Maschile" })
    expect(REPLY_VOICE_CHOICES.find((choice) => choice.value === "paola")?.title).toBe("Femminile")
    expect(REPLY_VOICE_CHOICES.map((choice) => choice.value).sort()).toEqual([...REPLY_VOICES].sort())
  })

  test("each Piper voice states that its model derives from a research-only dataset", () => {
    for (const choice of REPLY_VOICE_CHOICES.filter((c) => c.value !== "system")) {
      expect(choice.licence).toContain("sola ricerca")
    }
    expect(REPLY_VOICE_CHOICES.find((choice) => choice.value === "system")?.licence).toBeUndefined()
  })
})
