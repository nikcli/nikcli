import { describe, expect, test } from "bun:test"
import { createNaturalSpeaker, splitSentences, type NaturalSpeakerDeps } from "./natural-speaker"
import { createFakeSpeaker } from "./speaker"

const wav = (text: string) => new TextEncoder().encode(text).buffer as ArrayBuffer
const said = (buffer: ArrayBuffer) => new TextDecoder().decode(buffer)

function harness(overrides: Partial<NaturalSpeakerDeps> = {}) {
  const fallback = createFakeSpeaker()
  const played: string[] = []
  const installs: string[] = []
  const events: string[] = []
  let installed = true
  const deps: NaturalSpeakerDeps = {
    voice: () => "ugo",
    status: async () => ({ supported: true, installed }),
    install: async (voice) => {
      installs.push(voice)
      installed = true
    },
    synthesize: async (_voice, text) => wav(text),
    play: async (buffer) => {
      played.push(said(buffer))
    },
    fallback,
    onInstall: (voice, state) => events.push(`${voice}:${state}`),
    ...overrides,
  }
  return { deps, fallback, played, installs, events, setInstalled: (value: boolean) => (installed = value) }
}

describe("tts/natural-speaker", () => {
  test("sentences split on their end, not on a decimal point, and a short one joins the next", () => {
    expect(splitSentences("Fatto. Ho aperto la sessione 3.5 sui test! Ti avviso quando finisce?")).toEqual([
      "Fatto. Ho aperto la sessione 3.5 sui test!",
      "Ti avviso quando finisce?",
    ])
    expect(splitSentences("  una   sola frase senza punto ")).toEqual(["una sola frase senza punto"])
    expect(splitSentences("")).toEqual([])
  })

  test("an installed voice reads every sentence in order through Piper", async () => {
    const h = harness({
      // The second sentence comes back first: order is the reply's, not the host's.
      synthesize: (_voice, text) => new Promise((resolve) => setTimeout(() => resolve(wav(text)), text.startsWith("Ho") ? 20 : 1)),
    })
    await createNaturalSpeaker(h.deps).speak("Ho aperto una sessione Codex. Ti avviso quando ha finito.")
    expect(h.played).toEqual(["Ho aperto una sessione Codex.", "Ti avviso quando ha finito."])
    expect(h.fallback.spoken).toEqual([])
  })

  test("text asked for ahead is synthesised once, before its turn", async () => {
    const asked: string[] = []
    const h = harness({
      synthesize: async (_voice, text) => {
        asked.push(text)
        return wav(text)
      },
    })
    const speaker = createNaturalSpeaker(h.deps)
    await speaker.speak("Pronta la prima risposta.")
    speaker.prefetch?.("Seconda frase lunga. Terza frase lunga.")
    expect(asked).toEqual(["Pronta la prima risposta.", "Seconda frase lunga.", "Terza frase lunga."])
    await speaker.speak("Seconda frase lunga. Terza frase lunga.")
    expect(asked).toHaveLength(3)
    expect(h.played.slice(1)).toEqual(["Seconda frase lunga.", "Terza frase lunga."])
    // A cancel drops what was asked for ahead.
    speaker.prefetch?.("Quarta frase lunga.")
    speaker.cancel()
    await speaker.speak("Quarta frase lunga.")
    expect(asked.filter((t) => t === "Quarta frase lunga.")).toHaveLength(2)
  })

  test("a voice not downloaded yet speaks with the old voice and starts the download once", async () => {
    const h = harness()
    h.setInstalled(false)
    const speaker = createNaturalSpeaker(h.deps)
    await speaker.speak("Prima risposta.")
    await speaker.speak("Seconda risposta.")
    expect(h.fallback.spoken).toEqual(["Prima risposta."])
    expect(h.installs).toEqual(["ugo"])
    expect(h.events).toEqual(["ugo:downloading", "ugo:ready"])
    // Once ready, Piper answers.
    expect(h.played).toEqual(["Seconda risposta."])
  })

  test("the system voice, or a host without Piper, is the Web Speech voice", async () => {
    const system = harness({ voice: () => "system" })
    await createNaturalSpeaker(system.deps).speak("Ciao.")
    expect(system.fallback.spoken).toEqual(["Ciao."])

    const mac = harness({ status: async () => ({ supported: false, installed: false }) })
    await createNaturalSpeaker(mac.deps).speak("Ciao.")
    expect(mac.fallback.spoken).toEqual(["Ciao."])
    expect(mac.installs).toEqual([])
  })

  test("a sentence Piper fails leaves the rest of the reply to the old voice", async () => {
    const h = harness({
      synthesize: async (_voice, text) => {
        if (text.startsWith("Seconda")) throw new Error("Piper si è chiuso.")
        return wav(text)
      },
    })
    await createNaturalSpeaker(h.deps).speak("Prima frase lunga. Seconda frase lunga. Terza frase lunga.")
    expect(h.played).toEqual(["Prima frase lunga."])
    expect(h.fallback.spoken).toEqual(["Seconda frase lunga. Terza frase lunga."])
  })

  test("a Piper that never answers does not keep the reply silent: the old voice takes over", async () => {
    const h = harness({
      synthesisLimitMs: 30,
      synthesize: (_voice, text) => (text.startsWith("Seconda") ? new Promise<ArrayBuffer>(() => {}) : Promise.resolve(wav(text))),
    })
    await createNaturalSpeaker(h.deps).speak("Prima frase lunga. Seconda frase lunga.")
    expect(h.played).toEqual(["Prima frase lunga."])
    expect(h.fallback.spoken).toEqual(["Seconda frase lunga."])
  })

  test("a sentence synthesised but not playable is said in the old voice", async () => {
    const h = harness({
      play: async () => {
        throw new Error("play() rifiutato")
      },
    })
    await createNaturalSpeaker(h.deps).speak("Prima frase lunga. Seconda frase lunga.")
    expect(h.fallback.spoken).toEqual(["Prima frase lunga. Seconda frase lunga."])
  })

  test("prepare loads an installed voice once, silently, and starts the download of a missing one", async () => {
    const synthesized: string[] = []
    const h = harness({ synthesize: async (_voice, text) => (synthesized.push(text), wav(text)) })
    const speaker = createNaturalSpeaker(h.deps)
    speaker.prepare()
    await new Promise((resolve) => setTimeout(resolve, 5))
    speaker.prepare()
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(synthesized).toEqual(["Pronto."])
    expect(h.played).toEqual([])

    const missing = harness()
    missing.setInstalled(false)
    createNaturalSpeaker(missing.deps).prepare()
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(missing.installs).toEqual(["ugo"])
  })

  test("a new reply stops the one playing, and nothing of the old one plays after", async () => {
    let release: (() => void) | undefined
    const aborted: string[] = []
    const h = harness({
      play: (buffer, signal) =>
        new Promise<void>((resolve) => {
          const text = said(buffer)
          if (text.startsWith("Vecchia")) {
            signal.addEventListener("abort", () => {
              aborted.push(text)
              resolve()
            })
            release = resolve
          } else resolve()
        }),
    })
    const speaker = createNaturalSpeaker(h.deps)
    const old = speaker.speak("Vecchia risposta, prima frase. Vecchia risposta, seconda frase.")
    await new Promise((resolve) => setTimeout(resolve, 5))
    await speaker.speak("Nuova risposta.")
    release?.()
    await old
    expect(aborted).toEqual(["Vecchia risposta, prima frase."])
  })
})
