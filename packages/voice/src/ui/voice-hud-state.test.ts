import { describe, expect, it } from "bun:test"
import { agentHudState, latestExchange, HUD_WAVE, orbRim, preparingHudState, waveBarHeight } from "./voice-hud-state"

const base = { partial: "", spoken: "", readback: undefined, wakeWord: "hei nik" }

describe("orbRim", () => {
  it("is green while the microphone is open", () => {
    expect(orbRim({ running: true, preparing: false })).toBe("listening")
  })

  it("wears nothing when the microphone is shut and nothing went wrong", () => {
    expect(orbRim({ running: false, preparing: false })).toBeUndefined()
  })

  it("calls out a microphone that has not been granted on its own", () => {
    expect(orbRim({ running: false, preparing: false, errorKind: "mic-auth" })).toBe("mic-auth")
  })

  it("is red for everything else that went wrong", () => {
    expect(orbRim({ running: false, preparing: false, errorKind: "failed" })).toBe("failed")
  })

  /*
   * The case the ordering exists for. A failure leaves the microphone shut, so
   * if `running` ever lingered true alongside an error the widget would put a
   * green ring around its own failure message.
   */
  it("never shows green over a failure", () => {
    expect(orbRim({ running: true, preparing: false, errorKind: "mic-auth" })).toBe("mic-auth")
    expect(orbRim({ running: true, preparing: false, errorKind: "failed" })).toBe("failed")
  })

  /* Warming up is neither hearing you nor broken, and the pill says so in
     words and a percentage already. */
  it("wears nothing while the local model is still downloading", () => {
    expect(orbRim({ running: true, preparing: true })).toBeUndefined()
  })
})

describe("preparingHudState", () => {
  it("reports the percentage while the model downloads", () => {
    const state = preparingHudState({ percent: 42 })
    expect(state.tone).toBe("working")
    expect(state.label).toBe("preparo")
    expect(state.line).toBe("modello vocale · 42%")
  })

  /*
   * A download with no content-length reports bytes and no total, so there is
   * no percentage to show. It still has to say it is working: an empty widget
   * is the failure this state exists to prevent.
   */
  it("still says it is working when there is no total to divide by", () => {
    expect(preparingHudState({}).line).toBe("modello vocale…")
    expect(preparingHudState({ percent: Number.NaN }).line).toBe("modello vocale…")
  })

  it("never reports a percentage outside the bar", () => {
    expect(preparingHudState({ percent: -5 }).line).toBe("modello vocale · 0%")
    expect(preparingHudState({ percent: 140 }).line).toBe("modello vocale · 100%")
  })
})

describe("agentHudState", () => {
  it("quotes the wake word while the agent sleeps", () => {
    const state = agentHudState({ ...base, status: "asleep" })
    expect(state.tone).toBe("armed")
    expect(state.line).toBe("di' «hei nik»")
    expect(state.quoted).toBe(false)
  })

  it("shows the partial transcript as the user's own words", () => {
    const state = agentHudState({ ...base, status: "listening", partial: "apri la tavolozza" })
    expect(state.label).toBe("ascolto")
    expect(state.line).toBe("apri la tavolozza")
    expect(state.quoted).toBe(true)
  })

  /*
   * The regression this file exists for. A readback belongs to the command
   * that just finished; once new speech is arriving it describes the previous
   * one, and showing it would state the wrong thing with total confidence.
   */
  it("prefers new speech over the previous command's readback", () => {
    const state = agentHudState({
      ...base,
      status: "listening",
      partial: "chiudi questo",
      readback: "apro la tavolozza",
    })
    expect(state.line).toBe("chiudi questo")
    expect(state.quoted).toBe(true)
  })

  it("shows the readback once the speech has stopped", () => {
    const state = agentHudState({ ...base, status: "idle", readback: "apro la tavolozza" })
    expect(state.tone).toBe("done")
    expect(state.label).toBe("capito")
    expect(state.line).toBe("apro la tavolozza")
    expect(state.quoted).toBe(false)
  })

  it("invites speech when there is nothing to report", () => {
    const state = agentHudState({ ...base, status: "listening" })
    expect(state.line).toBe("parla pure")
    expect(state.quoted).toBe(false)
  })

  it("names what is being confirmed, not the raw words, when both exist", () => {
    const state = agentHudState({
      ...base,
      status: "confirming",
      spoken: "chiudi tutto",
      readback: "chiudo tutte le sessioni",
    })
    expect(state.tone).toBe("asking")
    expect(state.line).toBe("chiudo tutte le sessioni")
  })

  // An unparsed phrase still has to say something; the words are all there is.
  it("falls back to what was heard when there is no readback", () => {
    const state = agentHudState({ ...base, status: "executing", spoken: "chiudi tutto" })
    expect(state.tone).toBe("working")
    expect(state.line).toBe("chiudi tutto")
  })

  it("while an agent turn runs, shows the user's sentence, not the assistant's previous line", () => {
    const state = agentHudState({
      ...base,
      status: "executing",
      spoken: "Sono sveglio e in ascolto.",
      utterance: "quante sessioni ci sono aperte in ADE?",
    })
    expect(state.line).toBe("quante sessioni ci sono aperte in ADE?")
    expect(state.quoted).toBe(true)
    expect(state.label).toBe("eseguo")
  })

  it("a matched command still reads back what it does while executing", () => {
    const state = agentHudState({
      ...base,
      status: "executing",
      readback: "apro la tavolozza",
      utterance: "apri la tavolozza",
    })
    expect(state.line).toBe("apro la tavolozza")
    expect(state.quoted).toBe(false)
  })

  it("after the turn, shows the answer instead of 'parla pure'", () => {
    const state = agentHudState({
      ...base,
      status: "idle",
      utterance: "quante sessioni?",
      answer: "Ci sono tre sessioni aperte.",
    })
    expect(state).toMatchObject({
      label: "risposta",
      line: "Ci sono tre sessioni aperte.",
      quoted: false,
      tone: "done",
    })
    // New speech still wins over the old answer.
    expect(
      agentHudState({ ...base, status: "listening", partial: "e la", answer: "Ci sono tre sessioni aperte." }).line,
    ).toBe("e la")
  })

  it("latestExchange pairs the latest sentence with an answer only when it came after it", () => {
    const at = 1
    expect(latestExchange([{ kind: "assistant", text: "Sono sveglio e in ascolto.", at }])).toEqual({})
    expect(
      latestExchange([
        { kind: "assistant", text: "Sono sveglio e in ascolto.", at },
        { kind: "user", text: "quante sessioni?", at },
      ]),
    ).toEqual({ utterance: "quante sessioni?" })
    expect(
      latestExchange([
        { kind: "user", text: "prima", at },
        { kind: "assistant", text: "risposta vecchia", at },
        { kind: "user", text: "seconda", at },
        { kind: "assistant", text: "risposta nuova", at },
      ]),
    ).toEqual({ utterance: "seconda", answer: "risposta nuova" })
  })

  it("treats dictation as the user's words", () => {
    const state = agentHudState({ ...base, status: "dictating", partial: "ciao mondo" })
    expect(state.label).toBe("detto")
    expect(state.quoted).toBe(true)
  })

  // Every status the engine can report must produce a line; a widget with an
  // empty line reads as broken rather than as idle.
  it("answers for every dialogue status", () => {
    const statuses = ["asleep", "idle", "listening", "confirming", "dictating", "executing"] as const
    for (const status of statuses) {
      const state = agentHudState({ ...base, status, spoken: "qualcosa" })
      expect(state.line.length).toBeGreaterThan(0)
      expect(state.label.length).toBeGreaterThan(0)
    }
  })
})

describe("waveBarHeight", () => {
  it("keeps an uneven silhouette while the mic is closed", () => {
    const heights = HUD_WAVE.map((weight) => waveBarHeight(weight, 0, false))
    expect(Math.min(...heights)).toBeGreaterThan(0)
    expect(new Set(heights).size).toBeGreaterThan(1)
  })

  /*
   * The regression that sent this back for a second look: an open mic in a
   * quiet room reports a level near zero, and bars drawn straight from it
   * collapsed to a row of dots that read as a dead widget.
   */
  it("stays visible when the mic is open and the room is silent", () => {
    const heights = HUD_WAVE.map((weight) => waveBarHeight(weight, 0, true))
    for (const height of heights) expect(height).toBeGreaterThanOrEqual(18)
    // And still a silhouette: bars of one height are a ruled line, which reads
    // as a meter that has stopped rather than one waiting.
    expect(new Set(heights).size).toBeGreaterThan(1)
  })

  it("rises with the level and stays inside the row", () => {
    const quiet = waveBarHeight(1, 0.05, true)
    const loud = waveBarHeight(1, 0.9, true)
    expect(loud).toBeGreaterThan(quiet)
    expect(loud).toBeLessThanOrEqual(100)
  })

  // The meter is fed by a live signal, and a clipped one must not draw a bar
  // taller than the row that contains it.
  it("clamps a level past full scale", () => {
    expect(waveBarHeight(1, 12, true)).toBeLessThanOrEqual(100)
  })
})
