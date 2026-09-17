import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { createPanelRouter, ECHO_WINDOW_MS, REPEAT_WINDOW_MS, type HandledRequest, type PanelHandler } from "./router"
import { REPLY_PREFIX } from "./protocol"

const replyOf = (handled: HandledRequest | undefined) => (handled && "reply" in handled ? handled.reply : undefined)

const VERBS = [{ name: "play", usage: "play", summary: "avvia" }] as const

/** A panel that records what it was asked and answers as told. */
function panel(answer: PanelHandler["run"]): PanelHandler & { asked: string[] } {
  const asked: string[] = []
  return {
    asked,
    verbs: VERBS,
    run: (request) => {
      asked.push(`${request.verb} ${request.args.join(" ")}`.trim())
      return answer(request)
    },
  }
}

describe("createPanelRouter", () => {
  test("an ordinary line of output is not a request", async () => {
    const router = createPanelRouter()
    router.register(
      "video",
      panel(async () => ({ ok: true, detail: "fatto" })),
    )

    expect(await router.handle("Compiled 3 modules in 412ms")).toBeUndefined()
    // Including a line that talks *about* the protocol without being one.
    expect(await router.handle("puoi scrivere @ade video play per avviarlo")).toBeUndefined()
  })

  test("a request reaches the panel it names, and the reply says what happened", async () => {
    const router = createPanelRouter()
    const video = panel(async () => ({ ok: true, detail: "0:12.0 di 1:40.0, in riproduzione" }))
    router.register("video", video)

    const handled = await router.handle("@ade video seek 12")
    expect(video.asked).toEqual(["seek 12"])
    expect(replyOf(handled)).toBe(`${REPLY_PREFIX} video seek ok — 0:12.0 di 1:40.0, in riproduzione`)
  })

  test("the panel is told which session asked", async () => {
    const router = createPanelRouter()
    const from: (string | undefined)[] = []
    router.register("browser", {
      verbs: VERBS,
      run: async (_request, who) => {
        from.push(who)
        return { ok: true, detail: "" }
      },
    })
    await router.handle("@ade browser reload", "n1-2")
    await router.handle("@ade browser state")
    expect(from).toEqual(["n1-2", undefined])
  })

  test("a panel that is not open is told so, with the ones that are", async () => {
    const router = createPanelRouter()
    router.register(
      "video",
      panel(async () => ({ ok: true, detail: "" })),
    )

    const handled = await router.handle("@ade 3d rotate 90")
    /*
     * The failure this prevents: answering "ok" for a panel nobody is
     * showing. The agent would go on reasoning about a view that does not
     * exist, and nothing in the interface would contradict it.
     */
    expect(replyOf(handled)).toContain("errore")
    expect(replyOf(handled)).toContain("«3d» non è aperto")
    expect(replyOf(handled)).toContain("video")
  })

  test("with nothing open at all it says that instead of listing an empty set", async () => {
    const router = createPanelRouter()
    const handled = await router.handle("@ade video play")
    expect(replyOf(handled)).toContain("nessun pannello aperto")
  })

  test("a panel that throws still answers, because the agent is blocked on the line", async () => {
    const router = createPanelRouter()
    router.register(
      "video",
      panel(() => Promise.reject(new Error("il file non è leggibile"))),
    )

    const handled = await router.handle("@ade video play")
    expect(replyOf(handled)).toBe(`${REPLY_PREFIX} video play errore — il file non è leggibile`)
  })

  test("a closed panel stops answering", async () => {
    const router = createPanelRouter()
    router.register(
      "video",
      panel(async () => ({ ok: true, detail: "fatto" })),
    )
    expect(router.open()).toEqual(["video"])

    router.unregister("video")
    expect(router.open()).toEqual([])
    const handled = await router.handle("@ade video play")
    expect(replyOf(handled)).toContain("errore")
  })

  test("the reply ADE typed is never read back as a new request", async () => {
    const router = createPanelRouter()
    const video = panel(async () => ({ ok: true, detail: "fatto" }))
    router.register("video", video)

    // The terminal echoes what ADE writes; taking that for a request would be
    // a loop with no exit.
    const first = await router.handle("@ade video play")
    expect(first).toBeDefined()
    expect(await router.handle(replyOf(first)!)).toBeUndefined()
    expect(video.asked).toEqual(["play"])
  })

  test("a request a TUI keeps redrawing runs once, and the skip is said once (agy loop, 0.5.0 trial)", async () => {
    const router = createPanelRouter()
    const model = panel(async () => ({ ok: false, reason: "formato non supportato" }))
    router.register("model", model)

    const line = "@ade model open <percorso> — apre un modello 3D del progetto"
    const t = 1_000_000
    expect(replyOf(await router.handle(line, "agy", t))).toContain("errore")
    // A hook busy caused by typing that reply is not a new turn.
    router.newTurn("agy", t + 3000)
    // The reply typed back makes agy redraw the screen, and the same line comes again.
    const skipped = await router.handle(line, "agy", t + 2000)
    expect(skipped && "skipped" in skipped ? skipped.skipped : "").toStartWith("Riga non eseguita: @ade model open")
    for (let i = 2; i <= 5; i++) expect(await router.handle(line, "agy", t + i * 2000)).toBeUndefined()
    expect(model.asked).toHaveLength(1)
    // Another session writing the same line is its own request.
    expect(replyOf(await router.handle(line, "claude", t + 12_000))).toBeDefined()
    // Once the line has stopped coming back, writing it again is a new request.
    expect(replyOf(await router.handle(line, "agy", t + 11_000 + REPEAT_WINDOW_MS))).toBeDefined()
    expect(model.asked).toHaveLength(3)
  })

  test("a slow panel's reply still keeps its own busy from counting as a new turn", async () => {
    let clock = 0
    const router = createPanelRouter(() => clock)
    const model = panel(async () => {
      clock += 6000
      return { ok: true, detail: "catturato" }
    })
    router.register("model", model)

    const t = 1_000_000
    expect(replyOf(await router.handle("@ade model capture", "agy", t))).toBeDefined()
    // The reply was typed 6 s after the request; its busy arrives 3 s later.
    router.newTurn("agy", t + 9000)
    await router.handle("@ade model capture", "agy", t + 10_000)
    expect(model.asked).toEqual(["capture"])
  })

  test("state, view, state across turns all run", async () => {
    const router = createPanelRouter()
    const model = panel(async () => ({ ok: true, detail: "" }))
    router.register("model", model)

    const t = 1_000_000
    expect(replyOf(await router.handle("@ade model state", "s", t))).toBeDefined()
    router.newTurn("s", t + 8000)
    expect(replyOf(await router.handle("@ade model view front", "s", t + 9000))).toBeDefined()
    router.newTurn("s", t + 16_000)
    expect(replyOf(await router.handle("@ade model state", "s", t + 17_000))).toBeDefined()
    expect(model.asked).toEqual(["state", "view front", "state"])
  })

  test("text ADE just typed into a session is not run when its TUI echoes it, and only just", async () => {
    const router = createPanelRouter()
    const model = panel(async () => ({ ok: true, detail: "" }))
    router.register("model", model)

    const t = 1_000_000
    router.typed("s1", '[Messaggio da "Voice"]: prova   @ade model state   e dimmi', t)
    const echo = await router.handle("@ade model state", "s1", t + 500)
    expect(echo && "skipped" in echo ? echo.skipped : "").toContain("eco")
    // The same line written by the agent of a session ADE typed nothing into runs.
    expect(replyOf(await router.handle("@ade model state", "s2", t + 500))).toBeDefined()
    // A quote from minutes ago does not swallow the agent writing the line now.
    router.typed("s3", "cita @ade model state", t)
    expect(replyOf(await router.handle("@ade model state", "s3", t + ECHO_WINDOW_MS))).toBeDefined()
    expect(model.asked).toEqual(["state", "state"])
  })

  test("opening a panel types nothing into the sessions (six prompts queued in Claude Code, 0.5.0 trial)", () => {
    const source = readFileSync(join(import.meta.dir, "..", "surface", "workbench.tsx"), "utf8")
    const start = source.indexOf("const announcePanels = ")
    expect(start).toBeGreaterThan(-1)
    const body = source.slice(start, source.indexOf("\n  }\n", start))
    expect(body).toContain("panels.greeting(panel)")
    expect(body).not.toMatch(/\.write\(|typeLine|asSubmittedLine/)
  })

  test("the greeting describes the panel that is open, and nothing when none is", () => {
    const router = createPanelRouter()
    expect(router.greeting("video")).toEqual([])

    router.register(
      "video",
      panel(async () => ({ ok: true, detail: "" })),
    )
    const lines = router.greeting("video")
    expect(lines.length).toBeGreaterThan(2)
    // Every line is prefixed, so the greeting cannot be read back as requests.
    expect(lines.every((line) => line.startsWith(REPLY_PREFIX))).toBe(true)
    expect(lines.join("\n")).toContain("play")
  })
})
