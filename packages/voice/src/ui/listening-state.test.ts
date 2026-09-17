import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { setShortcutActivationEnabledForTests, setWakeWordEnabledForTests } from "../settings/model"
import { listeningState } from "./listening-state"

const on = { alwaysListen: true, activation: "wake-word" as const, wakeWord: "ei nik" }

describe("the always-on indicator", () => {
  // The wake word, on by default; set here so the block does not depend on the order it runs in.
  beforeAll(() => setWakeWordEnabledForTests(true))
  afterAll(() => setWakeWordEnabledForTests(true))
  test("shown for as long as the microphone listens by itself, naming the phrase", () => {
    const state = listeningState({ settings: on, running: true, mode: "agent", paused: false })
    expect(state.kind).toBe("listening")
    expect(state.kind === "listening" && state.text).toBe("In ascolto · «ei nik»")
  })

  test("says when it has paused, so the user knows why it stopped answering", () => {
    const state = listeningState({ settings: on, running: false, mode: "agent", paused: true })
    expect(state.kind === "paused" && state.text).toBe("Ascolto in pausa: PC bloccato")
  })

  test("hidden when switched off, on another activation, during dictation, or closed by hand", () => {
    expect(
      listeningState({ settings: { ...on, alwaysListen: false }, running: true, mode: "agent", paused: false }).kind,
    ).toBe("hidden")
    expect(
      listeningState({ settings: { ...on, activation: "toggle" }, running: true, mode: "agent", paused: false }).kind,
    ).toBe("hidden")
    expect(listeningState({ settings: on, running: true, mode: "transcription", paused: false }).kind).toBe("hidden")
    expect(listeningState({ settings: on, running: false, mode: "agent", paused: false }).kind).toBe("hidden")
  })
})

describe("with the wake word switched off", () => {
  // The 0.7.0 world, kept behind the switches: the wake word off, the shortcut the way in.
  beforeAll(() => {
    setWakeWordEnabledForTests(false)
    setShortcutActivationEnabledForTests(true)
  })
  afterAll(() => {
    setWakeWordEnabledForTests(true)
    setShortcutActivationEnabledForTests(false)
  })
  test("the indicator never shows, whatever was saved", () => {
    expect(listeningState({ settings: on, running: true, mode: "agent", paused: false }).kind).toBe("hidden")
    expect(listeningState({ settings: on, running: false, mode: "agent", paused: true }).kind).toBe("hidden")
  })
})

describe("after an answer", () => {
  test("the pill says it is listening without the name", () => {
    const state = listeningState({
      settings: { alwaysListen: true, activation: "wake-word", wakeWord: "nik" },
      running: true,
      mode: "agent",
      paused: false,
      followUp: true,
    })
    expect(state.kind).toBe("follow-up")
    expect(state.kind !== "hidden" && state.title).toContain("«nik»")
  })
})
