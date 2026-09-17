import { describe, expect, test } from "bun:test"
import {
  parseChord,
  matchesChord,
  formatChord,
  normalizeKeyName,
  resolveBinding,
  findConflicts,
  type Binding,
  type KeyInput,
} from "./keymap"

describe("normalizeKeyName", () => {
  test("the space bar's own event.key becomes the name a chord can carry", () => {
    // " " cannot survive a "+"-separated chord string, so it must have a name.
    expect(normalizeKeyName(" ")).toBe("space")
    expect(normalizeKeyName("Space")).toBe("space")
    expect(normalizeKeyName("Spacebar")).toBe("space")
  })

  test("reduces KeyboardEvent.code spellings to the event.key one", () => {
    expect(normalizeKeyName("KeyK")).toBe("k")
    expect(normalizeKeyName("Digit1")).toBe("1")
    expect(normalizeKeyName("Escape")).toBe("escape")
    expect(normalizeKeyName("ArrowUp")).toBe("arrowup")
  })

  test("folds legacy and shorthand names onto one spelling", () => {
    expect(normalizeKeyName("Esc")).toBe("escape")
    expect(normalizeKeyName("Return")).toBe("enter")
    expect(normalizeKeyName("Del")).toBe("delete")
    expect(normalizeKeyName("Up")).toBe("arrowup")
  })

  test("leaves an unknown key as its lowercase self", () => {
    expect(normalizeKeyName("F5")).toBe("f5")
    expect(normalizeKeyName("!")).toBe("!")
    expect(normalizeKeyName("")).toBe("")
  })
})

describe("parseChord", () => {
  test("mod maps to meta on mac", () => {
    const chord = parseChord("mod+p", "mac")
    expect(chord.meta).toBe(true)
    expect(chord.ctrl).toBe(false)
    expect(chord.key).toBe("p")
  })

  test("mod maps to ctrl on other platforms", () => {
    const chord = parseChord("mod+p", "other")
    expect(chord.ctrl).toBe(true)
    expect(chord.meta).toBe(false)
    expect(chord.key).toBe("p")
  })

  test("parses multiple modifiers", () => {
    const chord = parseChord("mod+shift+p", "mac")
    expect(chord.meta).toBe(true)
    expect(chord.shift).toBe(true)
    expect(chord.key).toBe("p")
  })

  test("is case-insensitive", () => {
    const chord = parseChord("Mod+Shift+P", "other")
    expect(chord.ctrl).toBe(true)
    expect(chord.shift).toBe(true)
    expect(chord.key).toBe("p")
  })

  test("parses alt/option modifier", () => {
    const chord = parseChord("alt+a", "other")
    expect(chord.alt).toBe(true)
    expect(chord.key).toBe("a")
  })

  test("parses named keys", () => {
    const chord = parseChord("mod+enter", "other")
    expect(chord.key).toBe("enter")
    expect(chord.ctrl).toBe(true)
  })

  test("parses arrow keys", () => {
    const chord = parseChord("mod+arrowup", "other")
    expect(chord.key).toBe("arrowup")
  })

  test("handles explicit ctrl on mac without converting to meta", () => {
    const chord = parseChord("ctrl+c", "mac")
    expect(chord.ctrl).toBe(true)
    expect(chord.meta).toBe(false)
  })

  test("parses space-separated and hyphen-separated chords like 'ctrl space' and 'ctrl-space'", () => {
    const chordSpace = parseChord("ctrl space", "other")
    expect(chordSpace.ctrl).toBe(true)
    expect(chordSpace.key).toBe("space")

    const chordHyphen = parseChord("ctrl-space", "other")
    expect(chordHyphen.ctrl).toBe(true)
    expect(chordHyphen.key).toBe("space")
  })
})

describe("matchesChord", () => {
  test("matches when all fields agree", () => {
    const chord = parseChord("mod+shift+p", "other")
    const event: KeyInput = { key: "p", ctrlKey: true, metaKey: false, shiftKey: true, altKey: false }
    expect(matchesChord(chord, event)).toBe(true)
  })

  test("rejects when a modifier differs", () => {
    const chord = parseChord("mod+p", "other")
    const event: KeyInput = { key: "p", ctrlKey: true, metaKey: false, shiftKey: true, altKey: false }
    expect(matchesChord(chord, event)).toBe(false)
  })

  test("rejects when the key differs", () => {
    const chord = parseChord("mod+p", "other")
    const event: KeyInput = { key: "k", ctrlKey: true, metaKey: false, shiftKey: false, altKey: false }
    expect(matchesChord(chord, event)).toBe(false)
  })

  test("matches case-insensitively on the key", () => {
    const chord = parseChord("mod+p", "other")
    const event: KeyInput = { key: "P", ctrlKey: true, metaKey: false, shiftKey: false, altKey: false }
    expect(matchesChord(chord, event)).toBe(true)
  })

  test("a chord written with the space bar fires on the space bar", () => {
    // The browser reports " " for this key; the chord is stored as "space".
    // These two disagreeing is what made a rebound Ctrl+Shift+Space dead.
    const chord = parseChord("mod+shift+space", "other")
    const event: KeyInput = { key: " ", ctrlKey: true, metaKey: false, shiftKey: true, altKey: false }
    expect(matchesChord(chord, event)).toBe(true)
  })

  test("matches a chord written in code spelling against a key-spelled event", () => {
    const chord = parseChord("mod+KeyK", "other")
    const event: KeyInput = { key: "k", ctrlKey: true, metaKey: false, shiftKey: false, altKey: false }
    expect(matchesChord(chord, event)).toBe(true)
  })

  test("modifier order in the written chord does not change what it matches", () => {
    const a = parseChord("shift+mod+alt+p", "other")
    const b = parseChord("Alt+Shift+Mod+P", "other")
    expect(a).toEqual(b)
    const event: KeyInput = { key: "P", ctrlKey: true, metaKey: false, shiftKey: true, altKey: true }
    expect(matchesChord(a, event)).toBe(true)
    expect(matchesChord(b, event)).toBe(true)
  })

  test("distinguishes Ctrl and Meta on mac", () => {
    const cmdChord = parseChord("mod+c", "mac")
    const ctrlEvent: KeyInput = { key: "c", ctrlKey: true, metaKey: false, shiftKey: false, altKey: false }
    const metaEvent: KeyInput = { key: "c", ctrlKey: false, metaKey: true, shiftKey: false, altKey: false }
    expect(matchesChord(cmdChord, ctrlEvent)).toBe(false)
    expect(matchesChord(cmdChord, metaEvent)).toBe(true)
  })

  test("handles shifted key values", () => {
    // On many keyboards, Shift+1 produces "!" as the key value
    const chord = parseChord("shift+1", "other")
    // The chord expects key "1" with shift — but the browser sends key "!"
    // This is a known platform issue; the chord system matches on the key string
    const event: KeyInput = { key: "1", ctrlKey: false, metaKey: false, shiftKey: true, altKey: false }
    expect(matchesChord(chord, event)).toBe(true)
  })
})

describe("formatChord", () => {
  test("formats mac chords with symbol glyphs", () => {
    const chord = parseChord("mod+shift+p", "mac")
    expect(formatChord(chord, "mac")).toBe("⇧⌘P")
  })

  test("formats other-platform chords with words", () => {
    const chord = parseChord("mod+shift+p", "other")
    expect(formatChord(chord, "other")).toBe("Ctrl+Shift+P")
  })

  test("formats single key without modifiers", () => {
    const chord = parseChord("escape", "other")
    expect(formatChord(chord, "other")).toBe("Esc")
  })

  test("formats arrow keys with symbols on mac", () => {
    const chord = parseChord("mod+arrowup", "mac")
    expect(formatChord(chord, "mac")).toBe("⌘↑")
  })

  test("includes ctrl symbol on mac when explicitly set", () => {
    const chord = parseChord("ctrl+c", "mac")
    expect(formatChord(chord, "mac")).toBe("⌃C")
  })
})

describe("resolveBinding", () => {
  const bindings: Binding[] = [
    { chord: parseChord("mod+p", "other"), commandId: "palette.open" },
    { chord: parseChord("mod+n", "other"), commandId: "session.new" },
  ]

  test("resolves a matching binding", () => {
    const event: KeyInput = { key: "p", ctrlKey: true, metaKey: false, shiftKey: false, altKey: false }
    expect(resolveBinding(bindings, event, "other")).toBe("palette.open")
  })

  test("returns undefined for unbound keys", () => {
    const event: KeyInput = { key: "z", ctrlKey: true, metaKey: false, shiftKey: false, altKey: false }
    expect(resolveBinding(bindings, event, "other")).toBeUndefined()
  })

  test("first match wins when there are duplicates", () => {
    const dupes: Binding[] = [
      { chord: parseChord("mod+p", "other"), commandId: "first" },
      { chord: parseChord("mod+p", "other"), commandId: "second" },
    ]
    const event: KeyInput = { key: "p", ctrlKey: true, metaKey: false, shiftKey: false, altKey: false }
    expect(resolveBinding(dupes, event, "other")).toBe("first")
  })
})

describe("findConflicts", () => {
  test("finds conflicting bindings", () => {
    const bindings: Binding[] = [
      { chord: parseChord("mod+p", "other"), commandId: "cmd-a" },
      { chord: parseChord("mod+p", "other"), commandId: "cmd-b" },
      { chord: parseChord("mod+n", "other"), commandId: "cmd-c" },
    ]
    const conflicts = findConflicts(bindings)
    expect(conflicts.length).toBe(1)
    expect(conflicts[0].commandIds).toContain("cmd-a")
    expect(conflicts[0].commandIds).toContain("cmd-b")
  })

  test("returns empty when there are no conflicts", () => {
    const bindings: Binding[] = [
      { chord: parseChord("mod+p", "other"), commandId: "cmd-a" },
      { chord: parseChord("mod+n", "other"), commandId: "cmd-b" },
    ]
    expect(findConflicts(bindings)).toEqual([])
  })

  test("same command bound twice is not a conflict", () => {
    const bindings: Binding[] = [
      { chord: parseChord("mod+p", "other"), commandId: "same" },
      { chord: parseChord("mod+p", "other"), commandId: "same" },
    ]
    expect(findConflicts(bindings)).toEqual([])
  })
})
