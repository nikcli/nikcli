import { describe, expect, test } from "bun:test"
import {
  CHECK_EVERY_MS,
  ERROR_BACKOFF_MS,
  MAX_CALLS_PER_HOUR,
  MIN_CHECK_GAP_MS,
  ReleaseFeedError,
  checkMessage,
  createUpdateWatch,
  githubReleaseFeed,
  retryAfter,
  type CheckResult,
  type ReleaseFeed,
} from "./watch"

const RELEASES = [
  {
    tag_name: "ade-v1.1.0",
    html_url: "https://github.com/SandroHub013/nikcli/releases/tag/ade-v1.1.0",
    draft: false,
    prerelease: false,
  },
]

/** A feed whose answers the test decides, counting what was asked of it. */
function feed(answers: (() => Promise<{ releases?: typeof RELEASES; notModified: boolean }>)[] = []) {
  let calls = 0
  const service: ReleaseFeed = {
    read: async () => {
      const answer = answers[calls] ?? (async () => ({ releases: RELEASES, notModified: false }))
      calls++
      return answer()
    },
  }
  return { service, calls: () => calls }
}

/** A watch over a clock the test moves by hand. */
function watching(options: { visible?: boolean; version?: string; answers?: Parameters<typeof feed>[0] } = {}) {
  let clock = 1_000_000
  const releases = feed(options.answers)
  const announced: string[] = []
  let visible = options.visible ?? true
  const watch = createUpdateWatch({
    currentVersion: async () => options.version ?? "1.0.0",
    onUpdate: (update) => announced.push(update.version),
    feed: releases.service,
    isVisible: () => visible,
    now: () => clock,
  })
  return {
    watch,
    announced,
    calls: releases.calls,
    advance: (ms: number) => {
      clock += ms
    },
    hide: () => {
      visible = false
    },
    show: () => {
      visible = true
    },
  }
}

describe("createUpdateWatch", () => {
  test("checks often enough to notice a release while the window is open", () => {
    expect(CHECK_EVERY_MS).toBeGreaterThanOrEqual(2 * 60_000)
    expect(CHECK_EVERY_MS).toBeLessThanOrEqual(5 * 60_000)
  })

  test("a new version is announced once, and later checks still report it", async () => {
    const it = watching()
    expect((await it.watch.check()).update?.version).toBe("1.1.0")
    it.advance(MIN_CHECK_GAP_MS)
    const again = await it.watch.check()
    expect(again.status).toBe("update")
    expect(it.announced).toEqual(["1.1.0"])
  })

  test("a build on the newest release is told so, with its own version", async () => {
    const it = watching({ version: "1.1.0" })
    const result = await it.watch.check()
    expect(result.status).toBe("current")
    expect(result.currentVersion).toBe("1.1.0")
    expect(checkMessage(result).text).toBe("Nessun aggiornamento: ADE 1.1.0 è l'ultima versione.")
  })

  test("a hidden window is not checked, and the check runs once it is back", async () => {
    const it = watching()
    it.hide()
    const skipped = await it.watch.check()
    expect(skipped.status).toBe("skipped")
    expect(it.calls()).toBe(0)

    it.show()
    expect((await it.watch.check()).status).toBe("update")
    expect(it.calls()).toBe(1)
  })

  test("two checks in a row are one call, unless a person asked", async () => {
    const it = watching()
    await it.watch.check()
    it.advance(MIN_CHECK_GAP_MS - 1)

    const tooSoon = await it.watch.check()
    expect(tooSoon.status).toBe("skipped")
    expect(it.calls()).toBe(1)

    // "Controlla aggiornamenti" does not wait for the timer.
    expect((await it.watch.check({ force: true })).status).toBe("update")
    expect(it.calls()).toBe(2)
  })

  test("a forced check works even with the window hidden", async () => {
    const it = watching()
    it.hide()
    expect((await it.watch.check({ force: true })).status).toBe("update")
    expect(it.calls()).toBe(1)
  })

  test("an unchanged list costs nothing, so the hourly budget is untouched", async () => {
    const answers = Array.from({ length: MAX_CALLS_PER_HOUR + 5 }, () => async () => ({ notModified: true }))
    const it = watching({ answers })
    for (let i = 0; i < MAX_CALLS_PER_HOUR + 5; i++) {
      const result = await it.watch.check({ force: true })
      expect(result.status).toBe("current")
      expect(result.cached).toBe(true)
    }
    expect(it.calls()).toBe(MAX_CALLS_PER_HOUR + 5)
  })

  /*
   * The command is pressed to confirm what the bell said. Answering "you are
   * on the newest one" because GitHub replied 304 — which carries no list —
   * would contradict the notice sitting right above it.
   */
  test("after an update was found, an unchanged answer still reports it", async () => {
    const it = watching({
      answers: [
        async () => ({ releases: RELEASES, notModified: false }),
        async () => ({ notModified: true }),
        async () => ({ notModified: true }),
      ],
    })
    expect((await it.watch.check({ force: true })).update?.version).toBe("1.1.0")

    const cached = await it.watch.check({ force: true })
    expect(cached.status).toBe("update")
    expect(cached.update?.version).toBe("1.1.0")
    expect(cached.cached).toBe(true)
    expect(checkMessage(cached).text).toBe("ADE 1.1.0 è disponibile")

    // And it is not announced twice: the bell already has that line.
    await it.watch.check({ force: true })
    expect(it.announced).toEqual(["1.1.0"])
  })

  test("an unchanged answer to a build that has since caught up says so", async () => {
    const it = watching({
      version: "1.1.0",
      answers: [async () => ({ releases: RELEASES, notModified: false }), async () => ({ notModified: true })],
    })
    expect((await it.watch.check({ force: true })).status).toBe("current")
    expect((await it.watch.check({ force: true })).status).toBe("current")
  })

  test("a refused request is not retried until GitHub said to come back", async () => {
    const it = watching({
      answers: [async () => Promise.reject(new ReleaseFeedError("GitHub 403", 1_000_000 + 30 * 60_000))],
    })
    expect((await it.watch.check({ force: true })).status).toBe("error")
    expect(it.calls()).toBe(1)

    // Not even by hand: asking again would only earn the same refusal.
    const waiting = await it.watch.check({ force: true })
    expect(waiting.status).toBe("skipped")
    expect(waiting.problem).toContain("aspettare")
    expect(it.calls()).toBe(1)

    it.advance(30 * 60_000)
    expect((await it.watch.check({ force: true })).status).toBe("update")
    expect(it.calls()).toBe(2)
  })

  test("without a time to come back, each failure in a row waits longer", async () => {
    const it = watching({ answers: Array.from({ length: 3 }, () => async () => Promise.reject(new Error("offline"))) })

    expect((await it.watch.check({ force: true })).status).toBe("error")
    it.advance(ERROR_BACKOFF_MS[0]! - 1)
    expect((await it.watch.check({ force: true })).status).toBe("skipped")

    it.advance(1)
    expect((await it.watch.check({ force: true })).status).toBe("error")
    // The second failure buys a longer wait than the first.
    it.advance(ERROR_BACKOFF_MS[0]!)
    expect((await it.watch.check({ force: true })).status).toBe("skipped")
    expect(it.calls()).toBe(2)
  })

  test("a dev build is told it is one, not that it is up to date", async () => {
    const it = watching({ version: "0.0.0" })
    const result = await it.watch.check({ force: true })
    expect(result.status).toBe("dev")
    expect(checkMessage(result).text).toContain("build di sviluppo")
    expect(it.announced).toEqual([])
  })

  test("the hourly budget stops the charged calls, and comes back an hour later", async () => {
    const it = watching()
    for (let i = 0; i < MAX_CALLS_PER_HOUR; i++) await it.watch.check({ force: true })
    expect(it.calls()).toBe(MAX_CALLS_PER_HOUR)

    const stopped = await it.watch.check({ force: true })
    expect(stopped.status).toBe("skipped")
    expect(stopped.problem).toContain("Troppi controlli")
    expect(it.calls()).toBe(MAX_CALLS_PER_HOUR)

    it.advance(60 * 60_000)
    expect((await it.watch.check({ force: true })).status).toBe("update")
    expect(it.calls()).toBe(MAX_CALLS_PER_HOUR + 1)
  })

  test("a failed request is reported, said plainly, and counted", async () => {
    const it = watching({ answers: [async () => Promise.reject(new Error("GitHub 503"))] })
    const result = await it.watch.check()
    expect(result.status).toBe("error")
    expect(checkMessage(result).kind).toBe("error")
    expect(checkMessage(result).text).toContain("GitHub 503")
  })

  test("the window coming back to the front asks for a check", async () => {
    let wake: (() => void) | undefined
    let released = false
    const releases = feed()
    const watch = createUpdateWatch({
      currentVersion: async () => "1.0.0",
      onUpdate: () => {},
      feed: releases.service,
      now: () => 1_000_000,
      onForeground: (run) => {
        wake = run
        return () => {
          released = true
        }
      },
    })
    watch.start()
    expect(typeof wake).toBe("function")
    wake?.()
    await Promise.resolve()
    await Promise.resolve()
    expect(releases.calls()).toBe(1)
    watch.stop()
    expect(released).toBe(true)
  })
})

describe("githubReleaseFeed", () => {
  test("asks with the tag it was given, and reads a 304 as unchanged", async () => {
    const seen: (HeadersInit | undefined)[] = []
    let call = 0
    const doFetch = (async (_url: string, init?: RequestInit) => {
      seen.push(init?.headers)
      call++
      if (call === 1) {
        return new Response(JSON.stringify(RELEASES), { status: 200, headers: { etag: 'W/"abc"' } })
      }
      return new Response(null, { status: 304 })
    }) as unknown as typeof fetch

    const it = githubReleaseFeed(doFetch)
    const first = await it.read()
    expect(first.releases?.length).toBe(1)
    expect((seen[0] as Record<string, string>)["If-None-Match"]).toBeUndefined()

    const second = await it.read()
    expect(second.notModified).toBe(true)
    expect(second.releases).toBeUndefined()
    expect((seen[1] as Record<string, string>)["If-None-Match"]).toBe('W/"abc"')
  })

  test("a failed request says which status it was", async () => {
    const doFetch = (async () => new Response("no", { status: 403 })) as unknown as typeof fetch
    expect(githubReleaseFeed(doFetch).read()).rejects.toThrow("GitHub 403")
  })

  test("the answer carries its tag, and a feed given one asks with it", async () => {
    const seen: (HeadersInit | undefined)[] = []
    const doFetch = (async (_url: string, init?: RequestInit) => {
      seen.push(init?.headers)
      return new Response(JSON.stringify(RELEASES), { status: 200, headers: { etag: 'W/"abc"' } })
    }) as unknown as typeof fetch

    expect((await githubReleaseFeed(doFetch).read()).etag).toBe('W/"abc"')
    await githubReleaseFeed(doFetch, 'W/"abc"').read()
    expect((seen[1] as Record<string, string>)["If-None-Match"]).toBe('W/"abc"')
  })
})

/*
 * What a restart remembers. The tag alone is a trap: it buys a `304`, and a
 * `304` carries no releases, so the window would come back knowing only that
 * nothing had changed since an answer it no longer had.
 */
describe("memory across restarts", () => {
  function store() {
    let saved: { etag?: string; update?: { version: string; url: string } } | undefined
    return {
      read: () => saved,
      write: (memory: { etag?: string; update?: { version: string; url: string } }) => {
        saved = memory
      },
      saved: () => saved,
    }
  }

  test("a release found in one run is still announced in the next, on a 304 alone", async () => {
    const memory = store()
    const announcedFirst: string[] = []
    const first = createUpdateWatch({
      currentVersion: async () => "1.0.0",
      onUpdate: (update) => announcedFirst.push(update.version),
      feed: { read: async () => ({ releases: RELEASES, notModified: false, etag: 'W/"abc"' }) },
      now: () => 1_000_000,
      memory,
    })
    expect((await first.check({ force: true })).update?.version).toBe("1.1.0")
    expect(announcedFirst).toEqual(["1.1.0"])
    expect(memory.saved()?.etag).toBe('W/"abc"')
    expect(memory.saved()?.update?.version).toBe("1.1.0")

    // ADE reopens: GitHub has nothing new to say, and the list never arrives.
    const announcedAgain: string[] = []
    const second = createUpdateWatch({
      currentVersion: async () => "1.0.0",
      onUpdate: (update) => announcedAgain.push(update.version),
      feed: { read: async () => ({ notModified: true }) },
      now: () => 2_000_000,
      memory,
    })
    const result = await second.check({ force: true })
    expect(result.status).toBe("update")
    expect(result.update?.version).toBe("1.1.0")
    expect(checkMessage(result).text).toBe("ADE 1.1.0 è disponibile")
    // The bell of the new window is empty, so this release is announced there too.
    expect(announcedAgain).toEqual(["1.1.0"])
  })

  test("a build that has caught up with the remembered release is not told to update", async () => {
    const memory = store()
    memory.write({ etag: 'W/"abc"', update: { version: "1.1.0", url: RELEASES[0]!.html_url } })
    const watch = createUpdateWatch({
      currentVersion: async () => "1.1.0",
      onUpdate: () => {
        throw new Error("non deve annunciare")
      },
      feed: { read: async () => ({ notModified: true }) },
      now: () => 1_000_000,
      memory,
    })
    expect((await watch.check({ force: true })).status).toBe("current")
  })

  test("a run that finds no release clears what was remembered", async () => {
    const memory = store()
    memory.write({ etag: 'W/"abc"', update: { version: "1.1.0", url: RELEASES[0]!.html_url } })
    const watch = createUpdateWatch({
      currentVersion: async () => "1.0.0",
      onUpdate: () => {},
      // The release was unpublished; the list arrives without it.
      feed: { read: async () => ({ releases: [], notModified: false, etag: 'W/"def"' }) },
      now: () => 1_000_000,
      memory,
    })
    expect((await watch.check({ force: true })).status).toBe("current")
    expect(memory.saved()).toEqual({ etag: 'W/"def"' })
  })
})

describe("retryAfter", () => {
  const head = (headers: Record<string, string>) => ({ headers: new Headers(headers), status: 403 })

  test("reads the seconds, the date, and the hour the allowance refills", () => {
    const at = 1_000_000
    expect(retryAfter(head({ "retry-after": "60" }), at)).toBe(at + 60_000)
    expect(retryAfter(head({ "retry-after": "Wed, 16 Sep 2026 10:00:00 GMT" }), at)).toBe(
      Date.parse("Wed, 16 Sep 2026 10:00:00 GMT"),
    )
    expect(retryAfter(head({ "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1700" }), at)).toBe(1_700_000)
  })

  test("the reset header alone, with calls left, is not a reason to wait", () => {
    expect(retryAfter(head({ "x-ratelimit-remaining": "37", "x-ratelimit-reset": "1700" }), 1_000_000)).toBeUndefined()
    expect(retryAfter(head({}), 1_000_000)).toBeUndefined()
  })
})

describe("checkMessage", () => {
  test("says something whatever happened", () => {
    const at = 0
    const cases: CheckResult[] = [
      {
        status: "update",
        at,
        update: { version: "1.2.0", url: "https://github.com/SandroHub013/nikcli/releases/tag/ade-v1.2.0" },
      },
      { status: "current", at, currentVersion: "1.2.0" },
      { status: "dev", at, currentVersion: "0.0.0" },
      { status: "skipped", at, problem: "Controllato da poco." },
      { status: "error", at, problem: "offline" },
    ]
    for (const result of cases) expect(checkMessage(result).text.length).toBeGreaterThan(0)
    expect(checkMessage(cases[0]!).href).toContain("/releases/tag/ade-v1.2.0")
  })
})
