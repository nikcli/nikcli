import { describe, expect, test } from "bun:test"
import { createPushToTalkHandler, resolveVoiceOrAdeKey, type PushToTalkTarget } from "./shortcuts"
import { parseChord, type Binding } from "../keyboard/keymap"
import {
  DEFAULT_VOICE_SETTINGS,
  VOICE_COMMAND_AGENT,
  VOICE_COMMAND_TRANSCRIPTION,
  type VoiceSettings,
  // The logic-only entry point: the main barrel re-exports Solid components,
  // which need Solid's compiler and so cannot load under a plain test runtime.
} from "@nikcli-ai/voice/core"

describe("resolveVoiceOrAdeKey", () => {
  const adeBindings: Binding[] = [
    { chord: parseChord("mod+shift+p", "other"), commandId: "palette.open" },
    { chord: parseChord("mod+n", "other"), commandId: "session.new" },
    { chord: parseChord("mod+w", "other"), commandId: "pane.close" },
  ]

  test("resolves normal ADE binding when no collision with voice exists", () => {
    const res = resolveVoiceOrAdeKey(
      adeBindings,
      DEFAULT_VOICE_SETTINGS,
      { key: "w", ctrlKey: true, shiftKey: false, altKey: false, metaKey: false },
      "other",
    )

    expect(res.type).toBe("ade")
    expect(res.commandId).toBe("pane.close")
    expect(res.conflict).toBeUndefined()
  })

  test("resolves configured voice chords when distinct from ADE bindings", () => {
    const agentRes = resolveVoiceOrAdeKey(
      adeBindings,
      DEFAULT_VOICE_SETTINGS,
      { key: "k", ctrlKey: true, shiftKey: true, altKey: false, metaKey: false },
      "other",
    )
    expect(agentRes.type).toBe("voice-agent")
    expect(agentRes.commandId).toBe(VOICE_COMMAND_AGENT)

    const transcriptionRes = resolveVoiceOrAdeKey(
      adeBindings,
      DEFAULT_VOICE_SETTINGS,
      { key: "j", ctrlKey: true, shiftKey: true, altKey: false, metaKey: false },
      "other",
    )
    expect(transcriptionRes.type).toBe("voice-transcription")
    expect(transcriptionRes.commandId).toBe(VOICE_COMMAND_TRANSCRIPTION)
  })

  test("la scorciatoia configurata che entra in conflitto con una di ADE: vince ADE e il conflitto viene riportato", () => {
    // User configured agentChord to collide with ADE's "mod+n" (session.new)
    const conflictingSettings: VoiceSettings = {
      ...DEFAULT_VOICE_SETTINGS,
      agentChord: "mod+n",
    }

    const res = resolveVoiceOrAdeKey(
      adeBindings,
      conflictingSettings,
      { key: "n", ctrlKey: true, shiftKey: false, altKey: false, metaKey: false },
      "other",
    )

    // 1. ADE wins: the returned type is 'ade' and the command is ADE's 'session.new'
    expect(res.type).toBe("ade")
    expect(res.commandId).toBe("session.new")

    // 2. Conflict is detected and reported
    expect(res.conflict).toBeDefined()
    expect(res.conflict?.commandIds).toContain("session.new")
    expect(res.conflict?.commandIds).toContain(VOICE_COMMAND_AGENT)
  })

  test("voice shortcut colliding with ADE does not activate voice even if ADE command were unhandled", () => {
    // Both agent and transcription chords collide
    const conflictingSettings: VoiceSettings = {
      ...DEFAULT_VOICE_SETTINGS,
      agentChord: "mod+w",
    }

    const res = resolveVoiceOrAdeKey(
      adeBindings,
      conflictingSettings,
      { key: "w", ctrlKey: true, shiftKey: false, altKey: false, metaKey: false },
      "other",
    )

    expect(res.type).toBe("ade")
    expect(res.commandId).toBe("pane.close")
    expect(res.conflict).toBeDefined()
  })

  /*
   * The point of the whole feature: a chord the user chose has to reach the
   * engine. Every one of these was recordable in the panel before; the space
   * bar was the one that then matched nothing at all, for ever, with nothing
   * said — a rebind that looks saved and is dead.
   */
  test.each([
    ["mod+shift+space", { key: " ", ctrlKey: true, shiftKey: true, altKey: false, metaKey: false }],
    ["mod+space", { key: " ", ctrlKey: true, shiftKey: false, altKey: false, metaKey: false }],
    ["ctrl space", { key: " ", ctrlKey: true, shiftKey: false, altKey: false, metaKey: false }],
    ["mod+alt+arrowup", { key: "ArrowUp", ctrlKey: true, shiftKey: false, altKey: true, metaKey: false }],
    ["alt+enter", { key: "Enter", ctrlKey: false, shiftKey: false, altKey: true, metaKey: false }],
    ["mod+f9", { key: "F9", ctrlKey: true, shiftKey: false, altKey: false, metaKey: false }],
    ["mod+plus", { key: "+", ctrlKey: true, shiftKey: false, altKey: false, metaKey: false }],
  ] as const)("una scorciatoia riassegnata a %s attiva la voce", (agentChord, event) => {
    const rebound: VoiceSettings = { ...DEFAULT_VOICE_SETTINGS, agentChord }

    const res = resolveVoiceOrAdeKey(adeBindings, rebound, event, "other")

    expect(res.type).toBe("voice-agent")
    expect(res.commandId).toBe(VOICE_COMMAND_AGENT)
  })

  test("rebinding one mode leaves the other mode's chord working", () => {
    const rebound: VoiceSettings = {
      ...DEFAULT_VOICE_SETTINGS,
      agentChord: "mod+alt+space",
    }

    expect(
      resolveVoiceOrAdeKey(
        adeBindings,
        rebound,
        { key: " ", ctrlKey: true, shiftKey: false, altKey: true, metaKey: false },
        "other",
      ).type,
    ).toBe("voice-agent")

    // The old agent chord is now free, and transcription is untouched.
    expect(
      resolveVoiceOrAdeKey(
        adeBindings,
        rebound,
        { key: "k", ctrlKey: true, shiftKey: true, altKey: false, metaKey: false },
        "other",
      ).type,
    ).toBe("none")
    expect(
      resolveVoiceOrAdeKey(
        adeBindings,
        rebound,
        { key: "j", ctrlKey: true, shiftKey: true, altKey: false, metaKey: false },
        "other",
      ).type,
    ).toBe("voice-transcription")
  })

  test("returns type none for unbound chords", () => {
    const res = resolveVoiceOrAdeKey(
      adeBindings,
      DEFAULT_VOICE_SETTINGS,
      { key: "x", ctrlKey: true, shiftKey: true, altKey: false, metaKey: false },
      "other",
    )
    expect(res.type).toBe("none")
    expect(res.commandId).toBeUndefined()
    expect(res.conflict).toBeUndefined()
  })
})

describe("createPushToTalkHandler", () => {
  /*
   * The two chords are two features, and the chord is what says which.
   *
   * Before this, the workbench answered a chord by *writing* the stored mode
   * and then calling the engine on the next line — so the setting the user
   * picked in the panel was replaced by whichever chord they last held, and
   * the write was not awaited, so the press could still be heard as the old
   * mode. The chord now carries its own mode down to `pressToTalk`.
   */
  test("il modo del tasto premuto arriva a pressToTalk, e nessuno tocca le impostazioni", async () => {
    const modes: (string | undefined)[] = []

    const mockEngine: PushToTalkTarget = {
      pressToTalk: async (mode) => {
        modes.push(mode)
      },
      releaseToTalk: async () => {},
    }

    const handler = createPushToTalkHandler(mockEngine)

    await handler.onKeyDown(parseChord("mod+shift+k", "other"), {}, "agent")
    await handler.onKeyUp("k")
    await handler.onKeyDown(parseChord("mod+shift+j", "other"), {}, "transcription")
    await handler.onKeyUp("j")

    expect(modes).toEqual(["agent", "transcription"])
  })

  test("senza modo il gesto resta quello di prima", async () => {
    const modes: (string | undefined)[] = []

    const mockEngine: PushToTalkTarget = {
      pressToTalk: async (mode) => {
        modes.push(mode)
      },
      releaseToTalk: async () => {},
    }

    const handler = createPushToTalkHandler(mockEngine)
    await handler.onKeyDown(parseChord("mod+shift+k", "other"), {})

    expect(modes).toEqual([undefined])
  })

  /*
   * The microphone belongs to the chord that is being held, not to the
   * keyboard in general. `onKeyUp` used to release on any key at all, so a
   * stray keystroke — or letting go of a key that was already down before the
   * chord — dropped the microphone in the middle of a sentence, which reads as
   * dictation randomly cutting out.
   */
  test("un tasto estraneo rilasciato non chiude il microfono", async () => {
    let releases = 0
    const mockEngine: PushToTalkTarget = {
      pressToTalk: async () => {},
      releaseToTalk: async () => {
        releases += 1
      },
    }

    const handler = createPushToTalkHandler(mockEngine)
    await handler.onKeyDown(parseChord("mod+shift+k", "other"), {}, "agent")

    await handler.onKeyUp("a")
    await handler.onKeyUp("enter")
    expect(releases).toBe(0)
    expect(handler.isPressed()).toBe(true)

    await handler.onKeyUp("k")
    expect(releases).toBe(1)
  })

  /* A modifier the chord needs is part of the chord: letting it go means the
     chord is no longer held, and nothing else would ever close the mic. */
  test("lasciare un modificatore del tasto chiude il microfono", async () => {
    let releases = 0
    const mockEngine: PushToTalkTarget = {
      pressToTalk: async () => {},
      releaseToTalk: async () => {
        releases += 1
      },
    }

    const handler = createPushToTalkHandler(mockEngine)
    await handler.onKeyDown(parseChord("mod+shift+k", "other"), {}, "agent")
    await handler.onKeyUp("Shift")

    expect(releases).toBe(1)
  })

  /* Blur and the watchdog have no key to compare, and the only safe answer
     there is to let go. */
  test("senza tasto si rilascia comunque", async () => {
    let releases = 0
    const mockEngine: PushToTalkTarget = {
      pressToTalk: async () => {},
      releaseToTalk: async () => {
        releases += 1
      },
    }

    const handler = createPushToTalkHandler(mockEngine)
    await handler.onKeyDown(parseChord("mod+shift+k", "other"), {}, "agent")
    await handler.onKeyUp()

    expect(releases).toBe(1)
  })

  test("event.repeat durante il push to talk non riavvia l'ascolto", async () => {
    let pressCount = 0
    let releaseCount = 0

    const mockEngine: PushToTalkTarget = {
      pressToTalk: async () => {
        pressCount += 1
      },
      releaseToTalk: async () => {
        releaseCount += 1
      },
    }

    const handler = createPushToTalkHandler(mockEngine)
    const chord = parseChord("mod+shift+k", "other")

    // 1. Initial keydown starts listening
    const firstPress = await handler.onKeyDown(chord, { repeat: false })
    expect(firstPress).toBe(true)
    expect(pressCount).toBe(1)
    expect(handler.isPressed()).toBe(true)

    // 2. Auto-repeat events while key is held down must be ignored
    const repeat1 = await handler.onKeyDown(chord, { repeat: true })
    expect(repeat1).toBe(false)
    expect(pressCount).toBe(1) // Still 1! No restart

    const repeat2 = await handler.onKeyDown(chord, { repeat: true })
    expect(repeat2).toBe(false)
    expect(pressCount).toBe(1) // Still 1!

    const repeat3 = await handler.onKeyDown(chord, { repeat: false }) // Duplicate press while isPressed
    expect(repeat3).toBe(false)
    expect(pressCount).toBe(1)

    // 3. Keyup releases listening
    const keyUpRes = await handler.onKeyUp("k")
    expect(keyUpRes).toBe(true)
    expect(releaseCount).toBe(1)
    expect(handler.isPressed()).toBe(false)

    // Further keyup is ignored
    const redundantKeyUp = await handler.onKeyUp("k")
    expect(redundantKeyUp).toBe(false)
    expect(releaseCount).toBe(1)
  })

  test("window blur while key is held releases listening immediately", async () => {
    let releaseCount = 0

    const mockEngine: PushToTalkTarget = {
      pressToTalk: async () => {},
      releaseToTalk: async () => {
        releaseCount += 1
      },
    }

    const handler = createPushToTalkHandler(mockEngine)
    const chord = parseChord("mod+shift+k", "other")

    await handler.onKeyDown(chord, { repeat: false })
    expect(handler.isPressed()).toBe(true)

    // Window blurs (e.g. user Alt-Tabs or clicks outside)
    const blurRes = await handler.onBlur()
    expect(blurRes).toBe(true)
    expect(releaseCount).toBe(1)
    expect(handler.isPressed()).toBe(false)

    // Subsequent blur does nothing
    const blurRes2 = await handler.onBlur()
    expect(blurRes2).toBe(false)
    expect(releaseCount).toBe(1)
  })
})

describe("push-to-talk watchdog", () => {
  test("releases the microphone when keyup never arrives", async () => {
    const calls: string[] = []
    let fire: (() => void) | undefined

    const handler = createPushToTalkHandler(
      {
        pressToTalk: async () => {
          calls.push("press")
        },
        releaseToTalk: async () => {
          calls.push("release")
        },
      },
      {
        setTimer: (fn) => {
          fire = fn
          return 1
        },
        clearTimer: () => {
          fire = undefined
        },
        maxHoldMs: 1000,
      },
    )

    await handler.onKeyDown(parseChord("mod+shift+k", "other"), {})
    expect(calls).toEqual(["press"])
    expect(handler.isPressed()).toBe(true)

    // The key is never released: a native modal ate the keyup and no blur came.
    fire?.()
    await Promise.resolve()

    expect(handler.isPressed()).toBe(false)
    expect(calls).toEqual(["press", "release"])
  })

  test("a normal release cancels the watchdog so it cannot fire twice", async () => {
    const calls: string[] = []
    let fire: (() => void) | undefined
    let cleared = false

    const handler = createPushToTalkHandler(
      {
        pressToTalk: async () => {
          calls.push("press")
        },
        releaseToTalk: async () => {
          calls.push("release")
        },
      },
      {
        setTimer: (fn) => {
          fire = fn
          return 1
        },
        clearTimer: () => {
          cleared = true
          fire = undefined
        },
        maxHoldMs: 1000,
      },
    )

    await handler.onKeyDown(parseChord("mod+shift+k", "other"), {})
    await handler.onKeyUp()

    expect(cleared).toBe(true)
    expect(fire).toBeUndefined()
    expect(calls).toEqual(["press", "release"])
  })

  test("rilasciare la barra spaziatrice o control su 'ctrl space' chiude il microfono", async () => {
    let releases = 0
    const mockEngine: PushToTalkTarget = {
      pressToTalk: async () => {},
      releaseToTalk: async () => {
        releases += 1
      },
    }

    const handler = createPushToTalkHandler(mockEngine)
    const chord = parseChord("ctrl space", "other")

    // Press down
    await handler.onKeyDown(chord, {}, "agent")
    expect(handler.isPressed()).toBe(true)

    // Releasing space key event (" " as browser produces for spacebar)
    await handler.onKeyUp(" ", "Space")
    expect(releases).toBe(1)
    expect(handler.isPressed()).toBe(false)

    // Press down again
    await handler.onKeyDown(chord, {}, "agent")
    expect(handler.isPressed()).toBe(true)

    // Releasing Control key
    await handler.onKeyUp("Control", "ControlLeft")
    expect(releases).toBe(2)
    expect(handler.isPressed()).toBe(false)
  })

  test("shouldReleaseKey correctly identifies matching key and code for chord release", async () => {
    const mockEngine: PushToTalkTarget = {
      pressToTalk: async () => {},
      releaseToTalk: async () => {},
    }

    const handler = createPushToTalkHandler(mockEngine)
    const chord = parseChord("ctrl space", "other")

    await handler.onKeyDown(chord, {})
    expect(handler.shouldReleaseKey(" ", "Space")).toBe(true)
    expect(handler.shouldReleaseKey("Control", "ControlLeft")).toBe(true)
    expect(handler.shouldReleaseKey("Control", "ControlRight")).toBe(true)
    expect(handler.shouldReleaseKey("Unidentified", "ControlLeft")).toBe(true)
    expect(handler.shouldReleaseKey("a", "KeyA")).toBe(false)
    expect(handler.shouldReleaseKey("Shift", "ShiftLeft")).toBe(false)

    await handler.onKeyUp(" ", "Space")
  })
})
